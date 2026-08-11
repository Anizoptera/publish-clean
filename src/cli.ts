#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { assertDeclaredFiles, assertSameEntries, validatePackedFiles } from "./artifact";
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
import { replaceTarballManifest } from "./tarball";
import {
  MIN_TRUSTED_NODE_VERSION,
  MIN_TRUSTED_NPM_VERSION,
  assertRepositoryForTrustedPublish,
  isAtLeast,
  wantsTrustedPublish,
} from "./trusted-publish";
import type { TrustedPublishEnv } from "./trusted-publish";

const TOOL_PROBE_TIMEOUT_MS = 10_000;

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

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function outputFromError(error: unknown, key: "stderr" | "stdout"): string {
  if (!isObject(error)) return "";
  const output = error[key];
  if (typeof output === "string") return output.trim();
  if (output instanceof Uint8Array) return Buffer.from(output).toString("utf8").trim();
  return "";
}

/**
 * Runs a command with its streams attached to this process instead of captured.
 *
 * Reserved for `npm publish`. Every other command here is run for its output or its
 * effect, but the publish is the one irreversible step, and npm's output is the only
 * receipt the operator gets: the version that went out, the tarball size, the integrity
 * hash, and the registry's own wording when it refuses. `run` would swallow all of it on
 * success and hold the failure text until the process exits, which in CI means a log
 * that says nothing about the one action that cannot be undone.
 */
function runAttached(command: string, args: readonly string[], cwd: string): void {
  execFileSync(command, [...args], { cwd, stdio: ["ignore", "inherit", "inherit"] });
}

/**
 * A required tool can fail three ways, and each one asks something different of the
 * reader, so the probe reports what it observed instead of assuming the common case.
 * A version-manager shim (asdf, mise, volta, corepack) resolves in PATH and still refuses
 * to run when no version is pinned; calling that absence sends the reader to verify the
 * one thing already correct, and `which pnpm` then agrees with them and not with us. The
 * shim's own message names the fix, so it is forwarded rather than replaced.
 */
function toolFailureReason(cause: unknown): string {
  if (isObject(cause)) {
    if (cause.code === "ENOENT") return "is not available in PATH";
    if (cause.code === "ETIMEDOUT")
      return `did not answer --version within ${TOOL_PROBE_TIMEOUT_MS}ms`;
  }
  const stderr = outputFromError(cause, "stderr");
  return `is present but failed to run${stderr ? `: ${stderr}` : ""}`;
}

/**
 * The probe is bounded because a wedged shim would otherwise hang the publish with no end:
 * `execFileSync` blocks this thread, so no timer here could ever interrupt it. The bound
 * belongs on the spawn itself. It stays generous because the only job is to separate a
 * tool that answers from one that never will.
 */
function requireTool(name: string): void {
  try {
    execFileSync(name, ["--version"], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: TOOL_PROBE_TIMEOUT_MS,
    });
  } catch (cause) {
    throw new PublishCleanError(`Required tool "${name}" ${toolFailureReason(cause)}.`, { cause });
  }
}

function npmVersion(): readonly [number, number, number] {
  const raw = run("npm", ["--version"], process.cwd()).trim();
  const parts = raw.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part)))
    throw new PublishCleanError(`Unable to parse npm version: ${raw}`);
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
  const actual = npmVersion();
  if (!isAtLeast(actual, MIN_TRUSTED_NPM_VERSION))
    throw new PublishCleanError(
      `Trusted npm publishing requires npm ${MIN_TRUSTED_NPM_VERSION.join(".")} or newer; found ${actual.join(".")}.`,
    );
  const node = process.versions.node.split(".").map(Number);
  const nodeVersion = [node[0] ?? 0, node[1] ?? 0, node[2] ?? 0] as const;
  if (isAtLeast(nodeVersion, MIN_TRUSTED_NODE_VERSION)) return;
  throw new PublishCleanError(
    `Trusted npm publishing requires Node.js ${MIN_TRUSTED_NODE_VERSION.join(".")} or newer; found ${process.versions.node}.`,
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
    throw new PublishCleanError("Unable to verify source git status.", {
      cause: error,
    });
  }
}

/**
 * The file list every content guard judges, read out of the archive by `tar` rather than from
 * an extracted copy: this is the same enumeration a consumer's installer sees, and it needs no
 * filesystem to exist.
 *
 * `tar tzf` prints one name per line, so a filename containing a newline would arrive as two
 * entries. That is safe in the only direction that matters, because every guard here fails
 * closed: splitting a name can only add entries to a leak scan that refuses on any match, and a
 * declared path whose name was split is then absent and refused as missing.
 */
function listTarballFiles(tarball: string, cwd: string): string[] {
  return run("tar", ["tzf", tarball], cwd)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((file) => file.replaceAll(path.sep, "/"))
    .map((file) => (file.startsWith("package/") ? file.slice(8) : file))
    .filter((file) => file.length > 0 && !file.endsWith("/"))
    .sort();
}

function readTarballJson(tarball: string, file: string, cwd: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(run("tar", ["xOzf", tarball, `package/${file}`], cwd)) as unknown;
  } catch (cause) {
    throw new PublishCleanError(`Unable to read JSON from ${path.basename(tarball)}: ${file}`, {
      cause,
    });
  }
  if (!isObject(parsed))
    throw new PublishCleanError(`${file} in ${path.basename(tarball)} must contain a JSON object.`);
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
    dryRun: boolean;
    guardOnly: boolean;
    noGitChecks: boolean;
    publishArgs: readonly string[];
    registry: null | string;
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
  requireTool("tar");
  warnIfNonPnpmLifecycle();

  const sourcePkgPath = path.join(packageDir, "package.json");
  const sourcePkg = readJson(sourcePkgPath);
  if (!opts.guardOnly && !opts.dryRun) assertTrustedPublishingRuntime(sourcePkg, opts.publishArgs);
  const config = packageConfig(sourcePkg);
  const skipFileCheck = opts.skipFileCheck || config.skipFileCheck === true;
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

    // Cleaned straight out of the packed tarball and written back into a copy of that same
    // tarball: no intermediate directory to clean, and no second packer that could re-decide
    // the file set from the `files` field this strips.
    const cleanedPkg = withRegistry(
      stripManifest(readTarballJson(tarball, "package.json", root), extraDevFields),
      registry,
    );
    const unrecognized = unrecognizedFieldsReport(cleanedPkg, keepFields);
    if (unrecognized) console.warn(unrecognized);

    const publishRoot = path.join(root, "publish");
    await mkdir(publishRoot);
    const finalTarball = path.join(publishRoot, path.basename(tarball));
    await writeFile(
      finalTarball,
      replaceTarballManifest(await readFile(tarball), stringifyJson(cleanedPkg)),
    );

    // Every guard reads the artifact that gets uploaded, and nothing else. Validating an
    // extracted copy instead would prove things about a directory nobody receives.
    const finalFiles = listTarballFiles(finalTarball, root);
    assertSameEntries(listTarballFiles(tarball, root), finalFiles);
    validatePackedFiles(finalFiles, skipFileCheck);
    assertDeclaredFiles(cleanedPkg, finalFiles);

    // Read back out of the final tarball, by tar, so the check is against the shipped bytes
    // rather than against the object this process just built. Reading the one member costs
    // one process; extracting the whole archive to reach it writes every file to disk for
    // nothing, and the directory it leaves is then somebody's problem to delete.
    const shippedPkg = readTarballJson(finalTarball, "package.json", root);
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
      "dry-run": { type: "boolean", default: false },
      "guard-only": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      "no-git-checks": { type: "boolean", default: false },
      registry: { type: "string", default: undefined },
      "skip-file-check": { type: "boolean", default: false },
      "tarball-out": { type: "string", default: undefined },
    },
    strict: true,
  });

  if (parsed.values.help) {
    console.log(
      "publish-clean [--dry-run] [--guard-only] [--no-git-checks] [--registry URL] [--skip-file-check] [--tarball-out DIR] [package-dir] [-- npm-publish-args]",
    );
    return;
  }
  if (parsed.positionals.length > 1)
    throw new PublishCleanError(
      `Unexpected positional arguments before --:\n${parsed.positionals.slice(1).join("\n")}`,
    );

  const packageDir = path.resolve(String(parsed.positionals[0] ?? "."));
  await packAndClean(packageDir, {
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
