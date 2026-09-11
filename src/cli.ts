#!/usr/bin/env node
// Node is the installed interpreter; invoking the file with Bun is an explicit alternative. Node is
// already guaranteed here — this tool spawns `npm`, which is itself a Node script — while Bun
// is not, and the shebang is the hard requirement: on POSIX the installed bin is a symlink the
// kernel resolves through this line, and npm's cmd-shim copies the interpreter name out of it
// into the Windows shim. Changing it makes every manager demand `bun` on PATH. A publisher who
// wants Bun's bytes runs the file path directly; the README says so.
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertDeclaredFiles, assertSameEntries, validatePackedFiles } from "./artifact";
import { requireTool, run } from "./command";
import { allowedUnreferenced, customDevFields, keptFields, packageConfig } from "./config";
import { reviewExports } from "./exports";
import { decide, formatFindings, isFatal } from "./finding";
import { reviewShippedFiles, reviewUnreferencedFiles } from "./shipped";
import { HELP, parseOptions } from "./options";
import { PublishCleanError } from "./error";
import { isObject, stringifyJson } from "./json";
import type { JsonObject } from "./json";
import {
  PUBLISH_ADVISORY,
  assertFilesField,
  assertNoLostConsumerFields,
  assertNoMonorepoProtocols,
  assertPublicPackage,
  assertRegistryDestinations,
  packageScope,
  stripManifest,
  unrecognizedFieldsReport,
  withRegistry,
} from "./manifest";
import {
  assertPreservedArchive,
  manifestText,
  packageContents,
  packageFiles,
  readArchive,
  replaceManifest,
} from "./tarball";
import type { TarArchive } from "./tarball";
import {
  MIN_TRUSTED_NODE_VERSION,
  MIN_TRUSTED_NPM_VERSION,
  assertRepositoryForTrustedPublish,
  isAtLeast,
  wantsTrustedPublish,
} from "./trusted-publish";
import type { TrustedPublishEnv } from "./trusted-publish";

/**
 * Read from the installed manifest rather than baked in at build time, so the number cannot
 * drift from the package a user actually has — which is the only reason anyone asks a tool
 * for its version.
 */
function ownVersion(): string {
  const manifest = readJson(fileURLToPath(new URL("../package.json", import.meta.url)));
  return typeof manifest.version === "string" ? manifest.version : "unknown";
}

function readJson(file: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (cause) {
    throw new PublishCleanError(`Unable to parse JSON file: ${file}`, {
      cause,
    });
  }
  if (!isObject(parsed)) throw new PublishCleanError(`${file} must contain a JSON object.`);
  return parsed;
}

/**
 * Asks an executable on PATH what version it is, e.g. `24.15.0` from node's `v24.15.0`.
 *
 * Both provenance floors are asked of PATH rather than read from this process, because the
 * process that has to satisfy them is npm's, not this one. `npm` is a `#!/usr/bin/env node`
 * script, so the Node enforcing the floor is whichever one PATH resolves — and that is not
 * necessarily the one executing this file. Under Bun the gap is total: `process.versions.node`
 * is a compatibility claim (1.3.14 reports 24.3.0) about a runtime that never runs npm at all,
 * so reading it would answer a question nobody asked while looking exactly like a check.
 */
function toolVersion(command: string, version: string): readonly [number, number, number] {
  const raw = version.trim().replace(/^v/, "");
  const parts = raw.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part)))
    throw new PublishCleanError(`Unable to parse ${command} version: ${raw}`);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * The single place the ambient environment is read for publish decisions. Naming the three
 * variables here keeps `process` out of the rules and makes the whole environmental surface of
 * a publish visible at once, rather than spread across the guards that consult it.
 */
function publishEnv(): TrustedPublishEnv {
  return {
    ACTIONS_ID_TOKEN_REQUEST_URL: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
  };
}

async function assertTrustedPublishingRuntime(
  cwd: string,
  npmVersion: string,
  signal: AbortSignal,
): Promise<void> {
  const npm = toolVersion("npm", npmVersion);
  if (!isAtLeast(npm, MIN_TRUSTED_NPM_VERSION))
    throw new PublishCleanError(
      `Trusted npm publishing requires npm ${MIN_TRUSTED_NPM_VERSION.join(".")} or newer; found ${npm.join(".")}.`,
    );
  const node = toolVersion("node", await requireTool("node", cwd, signal));
  if (isAtLeast(node, MIN_TRUSTED_NODE_VERSION)) return;
  throw new PublishCleanError(
    `Trusted npm publishing requires Node.js ${MIN_TRUSTED_NODE_VERSION.join(".")} or newer; found ${node.join(".")}.`,
  );
}

function warnIfNonPnpmLifecycle(): void {
  const userAgent = process.env.npm_config_user_agent;
  if (!userAgent || userAgent.startsWith("pnpm/")) return;
  console.warn(`${PUBLISH_ADVISORY} Detected lifecycle user agent: ${userAgent}`);
}

async function assertCleanGit(
  packageDir: string,
  skip: boolean,
  signal: AbortSignal,
): Promise<void> {
  if (skip) return;
  const output = (
    await run("git", ["status", "--porcelain", "--", "."], packageDir, { signal })
  ).trim();
  if (output) throw new PublishCleanError(`Source package has uncommitted changes:\n${output}`);
}

/**
 * Reads an archive from disk, so every judgement is made about bytes that exist as a file
 * rather than about a buffer this process is holding. The final artifact is read back this
 * way after it is written, which also proves the write itself landed whole.
 */
async function readTarball(tarball: string): Promise<TarArchive> {
  return readArchive(await readFile(tarball));
}

function manifestOf(archive: TarArchive, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText(archive)) as unknown;
  } catch (cause) {
    throw new PublishCleanError(`Unable to parse package.json inside ${label}.`, { cause });
  }
  if (!isObject(parsed))
    throw new PublishCleanError(`package.json inside ${label} must contain a JSON object.`);
  return parsed;
}

/**
 * Locates the tarball `pnpm pack` just produced by reading its destination directory.
 *
 * The pack targets a directory this process created and owns exclusively, so the result is
 * discoverable without interpreting the packer's output at all. That matters because `pack`
 * runs the package's `prepare`/`prepack` lifecycle scripts and forwards their stdout: any
 * build tool that logs — most of them — lands ahead of a `--json` payload and breaks a parse
 * of that stream. Reading the directory is immune to whatever a foreign package's scripts
 * choose to print.
 *
 * Exactly one tarball is the invariant, not a convenience: more than one means the
 * destination was not exclusive and the wrong artifact could be published.
 */
async function soleTarball(packRoot: string): Promise<string> {
  const tarballs = (await readdir(packRoot)).filter((entry) => entry.endsWith(".tgz"));
  const [tarball] = tarballs;
  if (tarballs.length !== 1 || !tarball)
    throw new PublishCleanError(
      `pnpm pack left ${tarballs.length} tarballs in ${packRoot}; expected exactly one.`,
    );
  return path.join(packRoot, tarball);
}

async function packAndClean(
  packageDir: string,
  signal: AbortSignal,
  opts: {
    /** Publish an artifact carrying tests, CI config, lockfiles or tsconfig anyway. */
    allowSuspicious: boolean;
    dryRun: boolean;
    guardOnly: boolean;
    /** Apply the exports/imports repairs this tool can prove neutral, rather than only report them. */
    heal: boolean;
    noGitChecks: boolean;
    publishArgs: readonly string[];
    registry: null | string;
    /** Publish a package whose manifest declares no `files` array. */
    skipFileCheck: boolean;
    /** Raise warnings to errors. Never promotes a finding this run already repaired. */
    strict: boolean;
    /**
     * Check only, never publish — and skip the `private: true` refusal, which is the ONE guard
     * that must not apply here. Verification is meant to work on packages that will never be
     * published; every other rule is identical, so a private package is checked by exactly the
     * rules it would face if it ever did go out.
     */
    verify: boolean;
    /**
     * Directory to copy the final tarball into before publishing, so callers can
     * keep the exact published bytes. Everything else here lives in a temp tree
     * that is removed on exit, which leaves a release pipeline with nothing to
     * attach to a GitHub Release or hand to build-provenance attestation.
     */
    tarballOut: null | string;
  },
): Promise<void> {
  const [, npmVersion] = await Promise.all([
    requireTool("pnpm", packageDir, signal),
    requireTool("npm", packageDir, signal),
  ]);
  warnIfNonPnpmLifecycle();

  const sourcePkgPath = path.join(packageDir, "package.json");
  const sourcePkg = readJson(sourcePkgPath);
  const config = packageConfig(sourcePkg);
  // Two independent policies, never one switch. The `files` requirement is a manifest
  // convention some packages legitimately do not follow; the artifact scan is what keeps
  // tests, CI config and lockfiles out of a published package. Sharing a flag meant opting
  // out of the convention silently disarmed the scan.
  const skipFileCheck = opts.skipFileCheck || config.skipFileCheck === true;
  const allowSuspicious = opts.allowSuspicious || config.allowSuspicious === true;
  const noGitChecks = opts.noGitChecks || config.noGitChecks === true;
  const registry = opts.registry ?? (typeof config.registry === "string" ? config.registry : null);
  const extraDevFields = customDevFields(config);
  const keepFields = keptFields(config);
  const allowUnreferenced = allowedUnreferenced(config);

  if (!opts.verify) assertPublicPackage(sourcePkg);
  await assertCleanGit(packageDir, noGitChecks, signal);
  assertFilesField(sourcePkg, skipFileCheck);

  const root = await mkdtemp(path.join(tmpdir(), "publish-clean-"));
  try {
    await run("pnpm", ["pack", "--pack-destination", root], packageDir, { signal, output: "pack" });
    const finalTarball = await soleTarball(root);
    const packed = await readTarball(finalTarball);

    // Keep the original archive in memory for comparison, then rewrite its owned temporary
    // file. A second packer could re-decide the file set from the `files` field this strips.
    const packedPkg = manifestOf(packed, "the packed tarball");
    if (!opts.verify) assertPublicPackage(packedPkg);
    // The packed manifest is what every check judges, because pnpm has already applied any
    // `publishConfig.exports` override by this point — so this value, not the source one, is
    // what consumers will resolve against.
    const review = reviewExports(withRegistry(stripManifest(packedPkg, extraDevFields), registry), {
      heal: opts.heal && config.heal !== false,
    });
    const findings = [...review.findings];
    const cleanedText = stringifyJson(review.manifest);
    const unrecognized = unrecognizedFieldsReport(review.manifest, keepFields);
    if (unrecognized) console.warn(unrecognized);

    await writeFile(finalTarball, replaceManifest(packed, cleanedText));

    // Every guard reads the artifact that gets uploaded, and nothing else — decoded again
    // from the file just written, never from the buffer that produced it. Validating the
    // in-memory value instead would let a bad write, or a defect in the rewriter, pass every
    // check and still ship.
    const finalBytes = await readFile(finalTarball);
    const published = readArchive(finalBytes);
    const finalFiles = packageFiles(published);
    assertSameEntries(packageFiles(packed), finalFiles);
    assertPreservedArchive(packed, published);
    validatePackedFiles(finalFiles, allowSuspicious);
    const shippedPkg = manifestOf(published, "the published tarball");
    assertRegistryDestinations(shippedPkg);
    assertDeclaredFiles(shippedPkg, finalFiles);
    assertNoMonorepoProtocols(shippedPkg, finalFiles);
    // A tripwire for this tool's own bugs: every field it would catch is either kept by design
    // or removed on request, and a removal on request is excluded from the comparison. Its
    // decision is exercised directly in the rules suite.
    // pnpm may consume publishConfig overrides; preserve its resolved consumer manifest.
    assertNoLostConsumerFields(packedPkg, shippedPkg, extraDevFields);
    // The manifest is the one member this tool authors rather than copies, so this is the check
    // that the rewrite produced the bytes the guards approved, not merely bytes that parse.
    if (manifestText(published) !== cleanedText)
      throw new PublishCleanError("Rewritten tarball manifest differs from the cleaned manifest.");

    // Read from the artifact that ships, like every other guard here. These checks need the file
    // BODIES — what a branch resolves to, and what nothing reaches — and the bytes are already
    // decoded, so this costs a map rather than a second decompression.
    const contents = packageContents(published);
    findings.push(
      ...reviewShippedFiles(shippedPkg, contents),
      ...reviewUnreferencedFiles(shippedPkg, contents, allowUnreferenced),
    );
    if (findings.length > 0) console.warn(formatFindings(findings, opts.strict));
    // Reported first, then decided: an author whose run is about to stop still gets every other
    // finding in the same output, rather than one per re-run.
    if (decide(findings, opts.strict))
      throw new PublishCleanError(
        `Refusing to publish: ${findings.filter((finding) => isFatal(finding, opts.strict)).length} ` +
          `unrepaired finding(s) above would reach consumers. A published version cannot be taken back.`,
      );

    // Configuration was validated before packing. Append the owned artifact, never a shell string.
    const validator = config.validateArtifact as readonly [string, ...string[]] | undefined;
    if (validator) {
      try {
        await run(validator[0], [...validator.slice(1), finalTarball], packageDir, {
          signal,
          output: "validator",
        });
        if (!finalBytes.equals(await readFile(finalTarball)))
          throw new PublishCleanError(
            "The validator changed the tarball. Validators must be read-only.",
          );
      } catch (cause) {
        throw new PublishCleanError(
          "publish-clean.validateArtifact failed; no tarball was retained or published.",
          { cause },
        );
      }
    }

    // Copied before publishing, and in every mode, so the retained bytes are exactly
    // the validated artifact regardless of whether the publish itself succeeds.
    if (opts.tarballOut !== null) {
      await mkdir(opts.tarballOut, { recursive: true });
      const kept = path.join(opts.tarballOut, path.basename(finalTarball));
      await copyFile(finalTarball, kept);
      console.log(`Final tarball kept at: ${kept}`);
    }

    // Prints the result instead of leaving a temp directory for the caller to delete.
    // Returning a path made cleanup the caller's job, so every dry-run leaked a tree.
    // Use --tarball-out to keep the bytes, in a directory the caller names.
    if (opts.dryRun) {
      console.log(`[dry-run] ${finalFiles.length} files:`);
      for (const file of finalFiles) console.log(`  ${JSON.stringify(file)}`);
      console.log(`[dry-run] cleaned package.json:\n${cleanedText}`);
      return;
    }
    if (opts.guardOnly || opts.verify) return;

    const env = publishEnv();
    let trusted = wantsTrustedPublish(shippedPkg, opts.publishArgs, env);
    if (trusted === undefined) {
      // npm owns npmrc/environment precedence; query only the non-secret setting needed here.
      const value = (
        await run("npm", ["config", "get", "provenance"], packageDir, { signal, timeout: 10_000 })
      ).trim();
      if (value !== "true" && value !== "false")
        throw new PublishCleanError("npm config get provenance must return true or false.");
      trusted = value === "true";
    }
    if (trusted) {
      await assertTrustedPublishingRuntime(packageDir, npmVersion, signal);
      assertRepositoryForTrustedPublish(shippedPkg, env);
    }
    const scope = packageScope(shippedPkg);
    const publishArgs = ["publish", finalTarball, ...opts.publishArgs];
    if (registry) {
      publishArgs.push("--registry", registry);
      if (scope) publishArgs.push(`--${scope}:registry=${registry}`);
    }
    // Run from the source package, never the temp tree. npm resolves its project `.npmrc` from
    // the nearest ancestor of the working directory holding a `package.json`, so publishing
    // from a temp directory silently discards the registry and credentials the author
    // configured for this project. Measured on npm 11: `npm config get registry` returns the
    // project value only when cwd sits under that manifest.
    await run("npm", publishArgs, packageDir, { signal, output: "publish" });
  } finally {
    // No mode keeps this tree. A failed run must not strand package contents in temp.
    await rm(root, { recursive: true, force: true });
  }
}

async function main(signal: AbortSignal): Promise<void> {
  const parsed = parseOptions(process.argv.slice(2));
  const { publishArgs } = parsed;

  if (parsed.values.version) {
    console.log(ownVersion());
    return;
  }
  if (parsed.values.help) {
    console.log(HELP);
    return;
  }
  if (parsed.positionals.length > 1)
    throw new PublishCleanError(
      `Unexpected positional arguments before --:\n${parsed.positionals.slice(1).join("\n")}`,
    );

  // Kept working rather than removed: it is in this repository's own `prepublishOnly` and in
  // everyone else's CI, and a flag that stops existing scripts is a migration nobody asked for.
  if (parsed.values["guard-only"] === true)
    console.warn(
      "publish-clean: --guard-only is deprecated; use `publish-clean verify` (or --verify-only), " +
        "which additionally works on a package marked private.",
    );

  const packageDir = path.resolve(String(parsed.positionals[0] ?? "."));
  await packAndClean(packageDir, signal, {
    allowSuspicious: parsed.values["allow-suspicious"] === true,
    dryRun: parsed.values["dry-run"] === true,
    guardOnly: parsed.values["guard-only"] === true,
    heal: parsed.values["no-heal"] !== true,
    noGitChecks: parsed.values["no-git-checks"] === true,
    publishArgs,
    registry: typeof parsed.values.registry === "string" ? parsed.values.registry : null,
    skipFileCheck: parsed.values["skip-file-check"] === true,
    strict: parsed.values.strict === true,
    verify: parsed.verify,
    tarballOut:
      typeof parsed.values["tarball-out"] === "string" ? parsed.values["tarball-out"] : null,
  });
}

const cancellation = new AbortController();
let interrupted = false;
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const)
  process.on(signal, () => {
    interrupted = true;
    process.exitCode = code;
    cancellation.abort(new PublishCleanError(`Cancelled by ${signal}.`));
  });

main(cancellation.signal).catch((error: unknown) => {
  console.error("publish-clean:", error instanceof PublishCleanError ? error.message : error);
  if (error instanceof PublishCleanError && error.cause) console.error("Caused by:", error.cause);
  if (!interrupted) process.exitCode = 1;
});
