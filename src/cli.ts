#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertDeclaredFiles, assertSameEntries, validatePackedFiles } from "./artifact";
import { outputFromError, requireTool, run, runAttached } from "./command";
import { PublishCleanError } from "./error";
import { isObject, stableJson, stringifyJson } from "./json";
import type { JsonObject } from "./json";
import {
  PUBLISH_ADVISORY,
  assertFilesField,
  assertNoLostConsumerFields,
  assertNoMonorepoProtocols,
  assertPublicPackage,
  customDevFields,
  keptFields,
  packageConfig,
  stripManifest,
  unrecognizedFieldsReport,
  withRegistry,
} from "./manifest";
import { manifestText, packageFiles, readArchive, replaceManifest } from "./tarball";
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
 * The whole interface in one screen, because this is where an out-of-context reader lands:
 * the flags, the manifest config block that sets the same policies durably, and the `--`
 * convention that decides which arguments this tool reads and which npm does. Anything a
 * user must know to publish correctly belongs here, not only in the README, which is not
 * installed next to the binary.
 */
const HELP = `publish-clean [options] [package-dir] [-- npm publish args]

Packs with pnpm, strips developer-only fields from the packed manifest, validates the
artifact, and publishes that exact tarball with npm. Arguments after \`--\` go to
\`npm publish\` untouched (e.g. --access public --tag next --provenance).

Options:
  --dry-run              Pack, clean and validate; print the file list and manifest, publish nothing.
  --guard-only           Same checks, no output and no publish. For a pre-publish gate.
  --tarball-out DIR      Also write the validated tarball into DIR, for attestation or release upload.
  --registry URL         Publish to URL, and record it in the artifact's publishConfig.
  --no-git-checks        Publish from a working tree with uncommitted changes.
  --skip-file-check      Allow a manifest with no "files" array.
  --allow-suspicious     Allow tests, CI config, lockfiles or tsconfig in the published artifact.
  -h, --help             Show this help.
  -v, --version          Show the publish-clean version.

Manifest configuration, under a "publish-clean" key in package.json:
  devFields    string[]  Extra fields to strip. Refused for fields consumers resolve.
  keepFields   string[]  Fields to acknowledge, so they stop being reported as unrecognised.
  registry     string    Default for --registry.
  noGitChecks  boolean   Default for --no-git-checks.
  skipFileCheck boolean  Default for --skip-file-check.
  allowSuspicious boolean Default for --allow-suspicious.

Requires pnpm and npm on PATH. npm provenance additionally requires Node.js 22.14+ and
npm 11.5.1+, and only a cloud CI runner can produce it.`;

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
function toolVersion(command: string): readonly [number, number, number] {
  const raw = run(command, ["--version"], process.cwd()).trim().replace(/^v/, "");
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

function assertTrustedPublishingRuntime(pkg: JsonObject, publishArgs: readonly string[]): void {
  if (!wantsTrustedPublish(pkg, publishArgs, publishEnv())) return;
  const npm = toolVersion("npm");
  if (!isAtLeast(npm, MIN_TRUSTED_NPM_VERSION))
    throw new PublishCleanError(
      `Trusted npm publishing requires npm ${MIN_TRUSTED_NPM_VERSION.join(".")} or newer; found ${npm.join(".")}.`,
    );
  const node = toolVersion("node");
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

function assertCleanGit(packageDir: string, skip: boolean): void {
  if (skip) return;
  try {
    const output = run("git", ["status", "--porcelain", "--", "."], packageDir).trim();
    if (output) throw new PublishCleanError(`Source package has uncommitted changes:\n${output}`);
  } catch (error) {
    if (error instanceof PublishCleanError) throw error;
    // git's own words, not a guess at them: outside a repository it says so exactly, and the
    // reader's next action ("this is not a git checkout" vs "git is not installed") differs.
    // The top-level handler only unwraps the error it is given, so the child's output has to
    // be carried into the message here or it is lost.
    const stderr = outputFromError(error, "stderr");
    throw new PublishCleanError(
      `Unable to verify source git status${stderr ? `: ${stderr}` : ""}.\nPass --no-git-checks to publish without this check.`,
      { cause: error },
    );
  }
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
  opts: {
    /** Publish an artifact carrying tests, CI config, lockfiles or tsconfig anyway. */
    allowSuspicious: boolean;
    dryRun: boolean;
    guardOnly: boolean;
    noGitChecks: boolean;
    publishArgs: readonly string[];
    registry: null | string;
    /** Publish a package whose manifest declares no `files` array. */
    skipFileCheck: boolean;
    /**
     * Directory to copy the final tarball into before publishing, so callers can
     * keep the exact published bytes. Everything else here lives in a temp tree
     * that is removed on exit, which leaves a release pipeline with nothing to
     * attach to a GitHub Release or hand to build-provenance attestation.
     */
    tarballOut: null | string;
  },
): Promise<void> {
  requireTool("pnpm");
  requireTool("npm");
  warnIfNonPnpmLifecycle();

  const sourcePkgPath = path.join(packageDir, "package.json");
  const sourcePkg = readJson(sourcePkgPath);
  if (!opts.guardOnly && !opts.dryRun) assertTrustedPublishingRuntime(sourcePkg, opts.publishArgs);
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

  assertPublicPackage(sourcePkg);
  assertCleanGit(packageDir, noGitChecks);
  assertFilesField(sourcePkg, skipFileCheck);

  const root = await mkdtemp(path.join(tmpdir(), "publish-clean-"));
  try {
    run("pnpm", ["pack", "--pack-destination", root], packageDir);
    const tarball = await soleTarball(root);
    const packed = await readTarball(tarball);

    // Cleaned straight out of the packed tarball and written back into a copy of that same
    // tarball: no intermediate directory to clean, and no second packer that could re-decide
    // the file set from the `files` field this strips.
    const cleanedPkg = withRegistry(
      stripManifest(manifestOf(packed, "the packed tarball"), extraDevFields),
      registry,
    );
    const unrecognized = unrecognizedFieldsReport(cleanedPkg, keepFields);
    if (unrecognized) console.warn(unrecognized);

    const publishRoot = path.join(root, "publish");
    await mkdir(publishRoot);
    const finalTarball = path.join(publishRoot, path.basename(tarball));
    await writeFile(finalTarball, replaceManifest(packed, stringifyJson(cleanedPkg)));

    // Every guard reads the artifact that gets uploaded, and nothing else — decoded again
    // from the file just written, never from the buffer that produced it. Validating the
    // in-memory value instead would let a bad write, or a defect in the rewriter, pass every
    // check and still ship.
    const published = await readTarball(finalTarball);
    const finalFiles = packageFiles(published);
    assertSameEntries(packageFiles(packed), finalFiles);
    validatePackedFiles(finalFiles, allowSuspicious);
    assertDeclaredFiles(cleanedPkg, finalFiles);

    const shippedPkg = manifestOf(published, "the published tarball");
    assertNoMonorepoProtocols(shippedPkg);
    // A tripwire for this tool's own bugs: every field it would catch is either kept by design
    // or removed on request, and a removal on request is excluded from the comparison. Its
    // decision is exercised directly in the rules suite.
    assertNoLostConsumerFields(sourcePkg, shippedPkg, extraDevFields);
    // The manifest is the one member this tool authors rather than copies, so this is the check
    // that the rewrite produced the bytes the guards approved, not merely bytes that parse.
    if (stableJson(shippedPkg) !== stableJson(cleanedPkg))
      throw new PublishCleanError("Rewritten tarball manifest differs from the cleaned manifest.");

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
      for (const file of finalFiles) console.log(`  ${file}`);
      console.log(`[dry-run] cleaned package.json:\n${stringifyJson(cleanedPkg)}`);
      return;
    }
    if (opts.guardOnly) return;

    assertRepositoryForTrustedPublish(cleanedPkg, opts.publishArgs, publishEnv());
    const publishArgs = registry
      ? ["publish", finalTarball, "--registry", registry, ...opts.publishArgs]
      : ["publish", finalTarball, ...opts.publishArgs];
    // Run from the source package, never the temp tree. npm resolves its project `.npmrc` from
    // the nearest ancestor of the working directory holding a `package.json`, so publishing
    // from a temp directory silently discards the registry and credentials the author
    // configured for this project. Measured on npm 11: `npm config get registry` returns the
    // project value only when cwd sits under that manifest.
    runAttached("npm", publishArgs, packageDir);
  } finally {
    // No mode keeps this tree. A failed run must not strand package contents in temp.
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const separator = rawArgs.indexOf("--");
  const cliArgs = separator === -1 ? rawArgs : rawArgs.slice(0, separator);
  const publishArgs = separator === -1 ? [] : rawArgs.slice(separator + 1);
  const parsed = parseArgs({
    args: cliArgs,
    allowPositionals: true,
    options: {
      "allow-suspicious": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "guard-only": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      "no-git-checks": { type: "boolean", default: false },
      registry: { type: "string", default: undefined },
      "skip-file-check": { type: "boolean", default: false },
      "tarball-out": { type: "string", default: undefined },
      version: { type: "boolean", short: "v", default: false },
    },
    strict: true,
  });

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

  const packageDir = path.resolve(String(parsed.positionals[0] ?? "."));
  await packAndClean(packageDir, {
    allowSuspicious: parsed.values["allow-suspicious"] === true,
    dryRun: parsed.values["dry-run"] === true,
    guardOnly: parsed.values["guard-only"] === true,
    noGitChecks: parsed.values["no-git-checks"] === true,
    publishArgs,
    registry: typeof parsed.values.registry === "string" ? parsed.values.registry : null,
    skipFileCheck: parsed.values["skip-file-check"] === true,
    tarballOut:
      typeof parsed.values["tarball-out"] === "string" ? parsed.values["tarball-out"] : null,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const details = [
    message,
    outputFromError(error, "stdout"),
    outputFromError(error, "stderr"),
  ].filter((detail) => detail.length > 0);
  console.error(`publish-clean: ${details.join("\n")}`);
  process.exitCode = 1;
});
