#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

type JsonObject = Record<string, unknown>;

const DEV_FIELDS = new Set([
  // Editor and schema hints, root-only install directives, and tool config blocks. Each
  // is either read exclusively from a workspace root, where an installed dependency is
  // never consulted, or by a tool the consumer does not run.
  "$schema",
  "catalog",
  "catalogs",
  "patchedDependencies",
  // The refusal to publish reads `private` from the source manifest before any stripping
  // happens, so removing it here cannot open a bypass. In a published manifest npm never
  // reads it back.
  "private",
  "stylelint",
  "trustedDependencies",
  "wireit",
  "devDependencies",
  "overrides",
  "resolutions",
  "ava",
  "c8",
  "jest",
  "mocha",
  "nyc",
  "tap",
  "vitest",
  "babel",
  "biome",
  "browserslist",
  "eslintConfig",
  "eslintIgnore",
  "prettier",
  "remarkConfig",
  "xo",
  "commitlint",
  "husky",
  "lint-staged",
  "simple-git-hooks",
  "clean-publish",
  "publish-clean",
  "semantic-release",
  "packageManager",
  "pnpm",
  "volta",
  "workspaces",
  "nx",
  "turbo",
]);

const CONSUMER_SCRIPTS = new Set(["preinstall", "install", "postinstall", "prepare", "uninstall"]);
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
  "resolutions",
] as const;
const MONOREPO_PROTOCOLS = ["catalog:", "workspace:", "link:", "portal:"];
/**
 * Fields a consumer's toolchain resolves. Stripping one breaks installs, imports or
 * platform gating, so `devFields` is not allowed to name them.
 */
const RUNTIME_MANIFEST_FIELDS = new Set([
  ...DEP_FIELDS,
  "bin",
  "browser",
  "bundleDependencies",
  "bundledDependencies",
  "cpu",
  "engines",
  "exports",
  "files",
  "imports",
  "libc",
  "license",
  "main",
  "module",
  "name",
  "os",
  "peerDependenciesMeta",
  "publishConfig",
  "sideEffects",
  "type",
  "types",
  "typesVersions",
  "typings",
  "version",
]);

/**
 * Fields npm's registry, website and CLI read, plus the de-facto entry points bundlers
 * and CDNs look for. Recognised, so they raise no report, but a maintainer may legitimately
 * strip any of them through `devFields`: none is load-bearing for an install.
 *
 * Together with RUNTIME_MANIFEST_FIELDS this is the answer to "does anything downstream
 * read this key?". Anything outside both sets is, as far as this tool can tell, project
 * bookkeeping that a consumer downloads and never uses.
 */
const REGISTRY_MANIFEST_FIELDS = new Set([
  "author",
  "bugs",
  "config",
  "contributors",
  "deno",
  "description",
  "directories",
  "funding",
  "gitHead",
  "homepage",
  "jsdelivr",
  "keywords",
  "maintainers",
  "man",
  "preferGlobal",
  "react-native",
  "repository",
  "sass",
  "scripts",
  "style",
  "styleModule",
  "svelte",
  "unpkg",
]);

/**
 * Names the fields that survived cleaning without anyone recognising them.
 *
 * The strip list can only ever describe tools that existed when it was written, so every
 * new `package.json` key some tool invents ships to consumers until a human notices. This
 * cannot be fixed by keeping only recognised fields: that would silently drop a key some
 * consumer genuinely resolves, and the breakage would surface in a stranger's project
 * rather than here. So the field ships, and the maintainer is told it did, with the exact
 * config that would drop it next time.
 *
 * Reported on stderr because it is advice about the package, not an error in it. Nothing
 * about the published artifact depends on whether anyone reads this.
 */
/**
 * Refuses a published manifest that lost a field the source declared and consumers read.
 *
 * Every other check here asks whether something got in that should not have. This asks the
 * opposite, and nothing else does: cleaning is subtraction, so the way it fails is by
 * taking too much. A dropped `repository` breaks provenance verification, a dropped
 * `exports` makes the package unimportable, and neither leaves any trace in the artifact
 * to notice later. The registry keeps the version forever either way.
 *
 * Compared against the *final* tarball rather than the cleaned directory, so a loss
 * introduced by the re-pack is caught as well as one introduced by stripping.
 *
 * `devFields` entries are exempt: removing those was the request. `scripts` is exempt
 * because it is rewritten rather than removed, down to the install lifecycle hooks a
 * consumer runs, and a package whose scripts are all developer-only correctly ends up with
 * none.
 */
function assertNoLostConsumerFields(
  sourcePkg: JsonObject,
  finalPkg: JsonObject,
  removedOnRequest: readonly string[],
): void {
  // DEV_FIELDS overlaps the recognised sets (`devDependencies` and friends are dependency
  // maps that are nonetheless always stripped), so a field removed by design can never
  // count as lost.
  const expected = new Set([...DEV_FIELDS, ...removedOnRequest, "scripts"]);
  const lost = Object.keys(sourcePkg).filter(
    (field) =>
      (RUNTIME_MANIFEST_FIELDS.has(field) || REGISTRY_MANIFEST_FIELDS.has(field)) &&
      !expected.has(field) &&
      !(field in finalPkg),
  );
  if (lost.length > 0)
    throw new PublishCleanError(
      `The published manifest is missing fields the source declared and consumers read:\n${lost.join("\n")}`,
    );
}

function reportUnrecognizedFields(pkg: JsonObject, kept: readonly string[]): void {
  const acknowledged = new Set(kept);
  const unrecognized = Object.keys(pkg).filter(
    (field) =>
      !RUNTIME_MANIFEST_FIELDS.has(field) &&
      !REGISTRY_MANIFEST_FIELDS.has(field) &&
      !acknowledged.has(field),
  );
  if (unrecognized.length === 0) return;
  console.warn(
    `publish-clean: these manifest fields are not recognised and were published as-is:\n` +
      `${unrecognized.map((field) => `  ${field}`).join("\n")}\n` +
      `Strip the ones consumers do not read, and acknowledge the ones they do:\n` +
      `  "publish-clean": { "devFields": [${unrecognized.map((f) => `"${f}"`).join(", ")}] }\n` +
      `  "publish-clean": { "keepFields": [${unrecognized.map((f) => `"${f}"`).join(", ")}] }`,
  );
}
/**
 * Content that must never reach a registry. Matched against tarball paths with the
 * `package/` prefix already stripped, so `^` means the package root.
 *
 * Case-insensitive throughout, because the filesystems most packages are built on are
 * too. On macOS and Windows `Server.PEM` and `server.pem` are the same file, so a
 * case-sensitive guard refuses one and publishes the other, which is worse than no guard:
 * it reads as coverage.
 *
 * Private keys are matched by extension and, separately, by exact filename. SSH keys carry
 * no extension at all, and `id_rsa` is the most common private-key filename there is. The
 * exact-name form deliberately does not match `id_rsa.pub`, which is public by design and
 * legitimate to ship.
 */
const CRITICAL_PATTERNS = [
  /(?:^|\/)node_modules(?:\/|$)/i,
  /(?:^|\/)\.git(?:\/|$)/i,
  /(?:^|\/)\.env(?:\.|$)/i,
  /(?:^|\/)\.npmrc$/i,
  /\.(?:pem|key|p12|pfx|p8|ppk|jks|keystore)$/i,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i,
];
const SUSPICIOUS_PATTERNS = [
  /(?:^|\/)(?:test|tests|__tests__|__snapshots__|coverage)(?:\/|$)/,
  /(?:^|\/)\.github(?:\/|$)/,
  /(?:^|\/)tsconfig[^/]*\.json$/,
  /(?:^|\/)(?:pnpm-lock\.yaml|bun\.lock|package-lock\.json)$/,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
];

/**
 * Shown when another package manager started this tool, so the pnpm requirement is not a
 * surprise. It names the packer and the consequence for the reader's own layout, rather
 * than claiming the alternatives are broken, because what a reader needs to do next
 * depends on which package manager they came from.
 *
 * The measured comparison behind the choice of packer, and the standing rule against
 * swapping it, live in this repository's AGENTS.md.
 */
const PUBLISH_ADVISORY =
  "publish-clean packs with pnpm: it resolves workspace: and catalog: specs from the packing package's own node_modules, so a Bun workspace works as-is and a Yarn one needs a pnpm-workspace.yaml plus one pnpm install. npm packs those specs unresolved.";
const MIN_TRUSTED_NPM_VERSION = [11, 5, 1] as const;
const TOOL_PROBE_TIMEOUT_MS = 10_000;

class PublishCleanError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PublishCleanError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function stringifyJson(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stableJson(value: JsonObject): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
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

function isAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (const index of [0, 1, 2] as const) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function wantsTrustedPublish(pkg: JsonObject, publishArgs: readonly string[]): boolean {
  if (publishArgs.includes("--provenance")) return true;
  if (isObject(pkg.publishConfig) && pkg.publishConfig.provenance === true) return true;
  return (
    process.env.GITHUB_ACTIONS === "true" &&
    typeof process.env.ACTIONS_ID_TOKEN_REQUEST_URL === "string"
  );
}

function assertTrustedPublishingRuntime(pkg: JsonObject, publishArgs: readonly string[]): void {
  if (!wantsTrustedPublish(pkg, publishArgs)) return;
  const actual = npmVersion();
  if (!isAtLeast(actual, MIN_TRUSTED_NPM_VERSION))
    throw new PublishCleanError(
      `Trusted npm publishing requires npm ${MIN_TRUSTED_NPM_VERSION.join(".")} or newer; found ${actual.join(".")}.`,
    );
  const node = process.versions.node.split(".").map(Number);
  const nodeVersion = [node[0] ?? 0, node[1] ?? 0, node[2] ?? 0] as const;
  if (isAtLeast(nodeVersion, [22, 14, 0])) return;
  throw new PublishCleanError(
    `Trusted npm publishing requires Node.js 22.14.0 or newer; found ${process.versions.node}.`,
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

function assertPublicPackage(pkg: JsonObject): void {
  if (pkg.private === true)
    throw new PublishCleanError("Refusing to publish a package with private: true.");
}

function repositoryUrl(pkg: JsonObject): null | string {
  if (typeof pkg.repository === "string") return pkg.repository;
  if (isObject(pkg.repository) && typeof pkg.repository.url === "string") return pkg.repository.url;
  return null;
}

function githubRepositorySlug(url: string): null | string {
  const withoutGitPrefix = url.startsWith("git+") ? url.slice(4) : url;
  if (withoutGitPrefix.startsWith("git@github.com:")) {
    const slug = withoutGitPrefix.slice("git@github.com:".length);
    return slug.endsWith(".git") ? slug.slice(0, -4) : slug;
  }
  try {
    const parsed = new URL(withoutGitPrefix);
    if (parsed.hostname !== "github.com") return null;
    const slug = parsed.pathname.replace(/^\/+/, "");
    return slug.endsWith(".git") ? slug.slice(0, -4) : slug;
  } catch {
    return null;
  }
}

function assertRepositoryForTrustedPublish(pkg: JsonObject, publishArgs: readonly string[]): void {
  if (!wantsTrustedPublish(pkg, publishArgs)) return;
  if (process.env.GITHUB_ACTIONS !== "true" || typeof process.env.GITHUB_REPOSITORY !== "string")
    return;
  const repoUrl = repositoryUrl(pkg);
  if (!repoUrl)
    throw new PublishCleanError(
      "GitHub trusted publishing requires package.json repository.url to match GITHUB_REPOSITORY.",
    );
  const slug = githubRepositorySlug(repoUrl);
  if (slug !== process.env.GITHUB_REPOSITORY)
    throw new PublishCleanError(
      `package.json repository.url must match GITHUB_REPOSITORY (${process.env.GITHUB_REPOSITORY}); found ${repoUrl}.`,
    );
}

function stripManifest(pkg: JsonObject, extraDevFields: readonly string[]): JsonObject {
  const stripped: JsonObject = { ...pkg };
  for (const field of [...DEV_FIELDS, ...extraDevFields]) delete stripped[field];

  const scripts = isObject(pkg.scripts) ? pkg.scripts : null;
  if (scripts) {
    const kept: JsonObject = {};
    for (const [name, value] of Object.entries(scripts)) {
      if (CONSUMER_SCRIPTS.has(name) && typeof value === "string") kept[name] = value;
    }
    if (Object.keys(kept).length > 0) stripped.scripts = kept;
    else delete stripped.scripts;
  }

  return stripped;
}

/**
 * Refuses a manifest that still carries a spec only a workspace can resolve. Published
 * with one, the package is uninstallable for everyone, and the version cannot be taken
 * back.
 *
 * Both call sites pass an already-stripped manifest, so the dev-only members of
 * DEP_FIELDS are absent by construction. They are still checked, because a guard whose
 * correctness depends on the order it happens to be called in fails silently the day
 * someone reorders it.
 */
function assertNoMonorepoProtocols(pkg: JsonObject): void {
  const failures: string[] = [];
  for (const field of DEP_FIELDS) {
    const map = pkg[field];
    if (!isObject(map)) continue;
    for (const [name, spec] of Object.entries(map)) {
      if (typeof spec !== "string") continue;
      if (MONOREPO_PROTOCOLS.some((prefix) => spec.includes(prefix)))
        failures.push(`${field}.${name}: ${spec}`);
    }
  }
  if (failures.length > 0) {
    throw new PublishCleanError(
      `Packed manifest contains unresolved monorepo-only dependency specs:\n${failures.join("\n")}\n${PUBLISH_ADVISORY}`,
    );
  }
}

function customDevFields(config: JsonObject): string[] {
  if (!Array.isArray(config.devFields)) return [];
  const fields = config.devFields.filter((field): field is string => typeof field === "string");
  const unsafe = fields.filter((field) => RUNTIME_MANIFEST_FIELDS.has(field));
  if (unsafe.length > 0)
    throw new PublishCleanError(
      `publish-clean.devFields cannot remove runtime/public manifest fields:\n${unsafe.join("\n")}`,
    );
  return fields;
}

/**
 * Fields the maintainer has confirmed belong in the published package, so they stop being
 * reported as unrecognised.
 *
 * Without this the report has only one resolution, `devFields`, which deletes the field.
 * That is the wrong answer for every package whose ecosystem this tool has never heard of:
 * a VS Code extension needs `contributes` and `publisher` in the artifact to function at
 * all. Its author would face a warning on every release that can only be silenced by
 * breaking the extension, and a warning nobody can act on trains everyone to ignore the
 * next one, including a real leak.
 */
function keptFields(config: JsonObject): readonly string[] {
  if (!Array.isArray(config.keepFields)) return [];
  return config.keepFields.filter((field): field is string => typeof field === "string");
}

async function walkFiles(dir: string, root: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    if (entry.isDirectory()) {
      await walkFiles(absolute, root, files);
      continue;
    }
    if (entry.isFile()) files.push(relative);
  }
}

function assertFilesField(pkg: JsonObject, skip: boolean): void {
  if (skip) return;
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    throw new PublishCleanError('Package manifest must define a non-empty "files" array.');
  }
}

function validatePackedFiles(files: readonly string[], skipSuspicious: boolean): void {
  const critical = files.filter((file) => CRITICAL_PATTERNS.some((pattern) => pattern.test(file)));
  if (critical.length > 0)
    throw new PublishCleanError(`Critical files must not be published:\n${critical.join("\n")}`);
  if (skipSuspicious) return;

  const suspicious = files.filter((file) =>
    SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(file)),
  );
  if (suspicious.length > 0)
    throw new PublishCleanError(`Suspicious files in package artifact:\n${suspicious.join("\n")}`);
}

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
    throw new PublishCleanError(`Unable to read JSON from final npm tarball: ${file}`, { cause });
  }
  if (!isObject(parsed))
    throw new PublishCleanError(`Final npm tarball ${file} must contain a JSON object.`);
  return parsed;
}

/**
 * Locates the tarball a packer just produced by reading its destination directory.
 *
 * Every pack here targets a directory this process created and owns exclusively, so
 * the result is discoverable without interpreting the packer's output at all. That
 * matters because `pack` runs the package's `prepare`/`prepack` lifecycle scripts and
 * forwards their stdout: any build tool that logs — most of them — lands ahead of the
 * `--json` payload and breaks a parse of that stream. Reading the directory is immune
 * to whatever a foreign package's scripts choose to print.
 *
 * Exactly one tarball is the invariant, not a convenience: more than one means the
 * destination was not exclusive and the wrong artifact could be published.
 */
async function soleTarball(packRoot: string, packer: string): Promise<string> {
  const tarballs = (await readdir(packRoot)).filter((entry) => entry.endsWith(".tgz"));
  const [tarball] = tarballs;
  if (tarballs.length !== 1 || !tarball)
    throw new PublishCleanError(
      `${packer} left ${tarballs.length} tarballs in ${packRoot}; expected exactly one.`,
    );
  return path.join(packRoot, tarball);
}

function assertFinalTarballIncludesCleanedFiles(
  cleanedFiles: readonly string[],
  finalFiles: readonly string[],
): void {
  const missing = cleanedFiles.filter((file) => !finalFiles.includes(file)).sort();
  if (missing.length === 0) return;
  throw new PublishCleanError(
    `Final npm tarball dropped files from the cleaned package:\n${missing.join("\n")}`,
  );
}

/**
 * Walks a manifest value of any shape and collects the strings that name a file inside
 * the package, so the caller can prove each one exists in the tarball.
 *
 * `mode` exists because the two families of path-bearing fields disagree about what a
 * bare string means, and reading one by the other's rules produces wrong answers in both
 * directions:
 *
 * - `"every-string"` for `main`, `module`, `types`, `typings`, `bin` and `typesVersions`,
 *   where every string is a path into this package.
 * - `"relative-only"` for `exports`, `imports`, `sideEffects` and the object form of
 *   `browser`, where a string may just as well be an external package name, a condition
 *   target or a glob. Only a `./` or `../` prefix marks it as a path here. Collecting the
 *   rest would report a missing file for something that was never a file.
 *
 * Booleans are skipped rather than ignored by accident: `sideEffects: false` and
 * `exports` condition values legitimately hold them.
 */
function collectDeclaredPaths(
  value: unknown,
  out: string[],
  mode: "every-string" | "relative-only",
): void {
  if (typeof value === "string") {
    if (mode === "every-string" || value.startsWith("./") || value.startsWith("../"))
      out.push(value);
    return;
  }
  if (typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (const item of value) collectDeclaredPaths(item, out, mode);
    return;
  }
  if (!isObject(value)) return;
  for (const item of Object.values(value)) collectDeclaredPaths(item, out, mode);
}

function normalizeDeclaredPath(declared: string): null | string {
  const withoutDot = declared.startsWith("./") ? declared.slice(2) : declared;
  if (!withoutDot || path.posix.isAbsolute(withoutDot)) return null;
  const normalized = path.posix.normalize(withoutDot);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function assertDeclaredFiles(pkg: JsonObject, packageDir: string): void {
  const paths: string[] = [];
  for (const field of ["main", "module", "types", "typings", "bin"]) {
    collectDeclaredPaths(pkg[field], paths, "every-string");
  }
  // `browser` is two fields sharing a name: a string is the replacement entry point, an
  // object is a map whose values may be `false` or another package's name.
  if (typeof pkg.browser === "string") collectDeclaredPaths(pkg.browser, paths, "every-string");
  else collectDeclaredPaths(pkg.browser, paths, "relative-only");
  for (const field of ["exports", "imports", "sideEffects"]) {
    collectDeclaredPaths(pkg[field], paths, "relative-only");
  }
  collectDeclaredPaths(pkg.typesVersions, paths, "every-string");
  const normalized = paths.map((declared) => ({
    declared,
    normalized: normalizeDeclaredPath(declared),
  }));
  const invalid = normalized.filter((item) => item.normalized === null);
  if (invalid.length > 0)
    throw new PublishCleanError(
      `Manifest declares invalid package paths:\n${invalid.map((item) => item.declared).join("\n")}`,
    );
  const missing = normalized.filter(
    (declared) =>
      !declared.declared.includes("*") &&
      !exists(path.join(packageDir, String(declared.normalized))),
  );
  if (missing.length > 0)
    throw new PublishCleanError(
      `Manifest declares files missing from packed artifact:\n${missing.map((item) => item.declared).join("\n")}`,
    );
}

function exists(file: string): boolean {
  try {
    const fileStat = statSync(file);
    if (!fileStat.isFile()) return false;
    return true;
  } catch {
    return false;
  }
}

function packageConfig(pkg: JsonObject): JsonObject {
  const config = pkg["publish-clean"];
  return isObject(config) ? config : {};
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
  let keepRoot = false;
  try {
    run("pnpm", ["pack", "--pack-destination", root], packageDir);
    const tarball = await soleTarball(root, "pnpm pack");
    run("tar", ["xzf", tarball, "-C", root], packageDir);

    const extracted = path.join(root, "package");
    const extractedStat = await stat(extracted);
    if (!extractedStat.isDirectory())
      throw new PublishCleanError("Extracted tarball did not contain package/ directory.");

    const files: string[] = [];
    await walkFiles(extracted, extracted, files);
    validatePackedFiles(files, skipFileCheck);

    const packedPkgPath = path.join(extracted, "package.json");
    const cleanedPkg = stripManifest(readJson(packedPkgPath), extraDevFields);
    if (registry) {
      const publishConfig = isObject(cleanedPkg.publishConfig)
        ? { ...cleanedPkg.publishConfig }
        : {};
      publishConfig.registry = registry;
      cleanedPkg.publishConfig = publishConfig;
    }
    assertNoMonorepoProtocols(cleanedPkg);
    reportUnrecognizedFields(cleanedPkg, keepFields);
    await writeFile(packedPkgPath, stringifyJson(cleanedPkg));
    assertDeclaredFiles(cleanedPkg, extracted);
    const cleanedFiles: string[] = [];
    await walkFiles(extracted, extracted, cleanedFiles);

    const finalPackRoot = path.join(root, "npm-pack");
    await mkdir(finalPackRoot);
    run("npm", ["pack", "--ignore-scripts", "--pack-destination", finalPackRoot], extracted);
    const finalTarball = await soleTarball(finalPackRoot, "npm pack");
    const finalFiles = listTarballFiles(finalTarball, extracted);
    validatePackedFiles(finalFiles, skipFileCheck);
    assertFinalTarballIncludesCleanedFiles(cleanedFiles, finalFiles);
    const finalPkg = readTarballJson(finalTarball, "package.json", extracted);
    assertNoMonorepoProtocols(finalPkg);
    assertNoLostConsumerFields(sourcePkg, finalPkg, extraDevFields);
    if (stableJson(finalPkg) !== stableJson(cleanedPkg))
      throw new PublishCleanError("Final npm tarball manifest differs from the cleaned manifest.");

    // Copied before publishing, and in every mode, so the retained bytes are exactly
    // the validated artifact regardless of whether the publish itself succeeds.
    if (opts.tarballOut !== null) {
      await mkdir(opts.tarballOut, { recursive: true });
      const kept = path.join(opts.tarballOut, path.basename(finalTarball));
      await copyFile(finalTarball, kept);
      console.log(`Final tarball kept at: ${kept}`);
    }

    if (opts.guardOnly || opts.dryRun) {
      if (!opts.dryRun) return;
      keepRoot = true;
      console.log(`[dry-run] Extracted package at: ${extracted}`);
      console.log(`[dry-run] Final tarball at: ${finalTarball}`);
      return;
    }

    assertRepositoryForTrustedPublish(cleanedPkg, opts.publishArgs);
    const publishArgs = registry
      ? ["publish", finalTarball, "--registry", registry, ...opts.publishArgs]
      : ["publish", finalTarball, ...opts.publishArgs];
    runAttached("npm", publishArgs, extracted);
  } finally {
    if (!keepRoot) await rm(root, { recursive: true, force: true });
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
