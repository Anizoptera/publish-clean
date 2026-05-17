#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

type JsonObject = Record<string, unknown>;

const DEV_FIELDS = new Set([
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

const CONSUMER_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "uninstall",
]);
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
  "resolutions",
] as const;
const MONOREPO_PROTOCOLS = ["catalog:", "workspace:", "link:", "portal:"];
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
  "license",
  "main",
  "module",
  "name",
  "optionalDependencies",
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
const CRITICAL_PATTERNS = [
  /(?:^|\/)node_modules(?:\/|$)/,
  /(?:^|\/)\.git(?:\/|$)/,
  /(?:^|\/)\.env(?:\.|$)/,
  /(?:^|\/)\.npmrc$/,
  /\.(?:pem|key|p12|pfx)$/,
];
const SUSPICIOUS_PATTERNS = [
  /(?:^|\/)(?:test|tests|__tests__|__snapshots__|coverage)(?:\/|$)/,
  /(?:^|\/)\.github(?:\/|$)/,
  /(?:^|\/)tsconfig[^/]*\.json$/,
  /(?:^|\/)(?:pnpm-lock\.yaml|bun\.lock|package-lock\.json)$/,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
];

const PUBLISH_ADVISORY =
  "publish-clean uses pnpm pack intentionally; npm, yarn, and bun pack do not reliably normalize pnpm workspace/catalog manifests.";
const MIN_TRUSTED_NPM_VERSION = [11, 5, 1] as const;

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
  if (!isObject(parsed))
    throw new PublishCleanError(`${file} must contain a JSON object.`);
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
  if (output instanceof Uint8Array)
    return Buffer.from(output).toString("utf8").trim();
  return "";
}

function requireTool(name: string): void {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
  } catch (cause) {
    throw new PublishCleanError(
      `Required tool "${name}" is not available in PATH.`,
      { cause },
    );
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

function wantsTrustedPublish(
  pkg: JsonObject,
  publishArgs: readonly string[],
): boolean {
  if (publishArgs.includes("--provenance")) return true;
  if (isObject(pkg.publishConfig) && pkg.publishConfig.provenance === true)
    return true;
  return (
    process.env.GITHUB_ACTIONS === "true" &&
    typeof process.env.ACTIONS_ID_TOKEN_REQUEST_URL === "string"
  );
}

function assertTrustedPublishingRuntime(
  pkg: JsonObject,
  publishArgs: readonly string[],
): void {
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
  console.warn(
    `${PUBLISH_ADVISORY} Detected lifecycle user agent: ${userAgent}`,
  );
}

function assertCleanGit(packageDir: string, skip: boolean): void {
  if (skip) return;
  try {
    const output = run(
      "git",
      ["status", "--porcelain", "--", "."],
      packageDir,
    ).trim();
    if (output)
      throw new PublishCleanError(
        `Source package has uncommitted changes:\n${output}`,
      );
  } catch (error) {
    if (error instanceof PublishCleanError) throw error;
    throw new PublishCleanError("Unable to verify source git status.", {
      cause: error,
    });
  }
}

function assertPublicPackage(pkg: JsonObject): void {
  if (pkg.private === true)
    throw new PublishCleanError(
      "Refusing to publish a package with private: true.",
    );
}

function repositoryUrl(pkg: JsonObject): null | string {
  if (typeof pkg.repository === "string") return pkg.repository;
  if (isObject(pkg.repository) && typeof pkg.repository.url === "string")
    return pkg.repository.url;
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

function assertRepositoryForTrustedPublish(
  pkg: JsonObject,
  publishArgs: readonly string[],
): void {
  if (!wantsTrustedPublish(pkg, publishArgs)) return;
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    typeof process.env.GITHUB_REPOSITORY !== "string"
  )
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

function stripManifest(
  pkg: JsonObject,
  extraDevFields: readonly string[],
): JsonObject {
  const stripped: JsonObject = { ...pkg };
  for (const field of [...DEV_FIELDS, ...extraDevFields])
    delete stripped[field];

  const scripts = isObject(pkg.scripts) ? pkg.scripts : null;
  if (scripts) {
    const kept: JsonObject = {};
    for (const [name, value] of Object.entries(scripts)) {
      if (CONSUMER_SCRIPTS.has(name) && typeof value === "string")
        kept[name] = value;
    }
    if (Object.keys(kept).length > 0) stripped.scripts = kept;
    else delete stripped.scripts;
  }

  return stripped;
}

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
  const pnpm = pkg.pnpm;
  if (isObject(pnpm) && isObject(pnpm.overrides)) {
    for (const [name, spec] of Object.entries(pnpm.overrides)) {
      if (
        typeof spec === "string" &&
        MONOREPO_PROTOCOLS.some((prefix) => spec.includes(prefix))
      )
        failures.push(`pnpm.overrides.${name}: ${spec}`);
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
  const fields = config.devFields.filter(
    (field): field is string => typeof field === "string",
  );
  const unsafe = fields.filter((field) => RUNTIME_MANIFEST_FIELDS.has(field));
  if (unsafe.length > 0)
    throw new PublishCleanError(
      `publish-clean.devFields cannot remove runtime/public manifest fields:\n${unsafe.join("\n")}`,
    );
  return fields;
}

async function walkFiles(
  dir: string,
  root: string,
  files: string[],
): Promise<void> {
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
    throw new PublishCleanError(
      'Package manifest must define a non-empty "files" array.',
    );
  }
}

function validatePackedFiles(
  files: readonly string[],
  skipSuspicious: boolean,
): void {
  const critical = files.filter((file) =>
    CRITICAL_PATTERNS.some((pattern) => pattern.test(file)),
  );
  if (critical.length > 0)
    throw new PublishCleanError(
      `Critical files must not be published:\n${critical.join("\n")}`,
    );
  if (skipSuspicious) return;

  const suspicious = files.filter((file) =>
    SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(file)),
  );
  if (suspicious.length > 0)
    throw new PublishCleanError(
      `Suspicious files in package artifact:\n${suspicious.join("\n")}`,
    );
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

function readTarballJson(
  tarball: string,
  file: string,
  cwd: string,
): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      run("tar", ["xOzf", tarball, `package/${file}`], cwd),
    ) as unknown;
  } catch (cause) {
    throw new PublishCleanError(
      `Unable to read JSON from final npm tarball: ${file}`,
      { cause },
    );
  }
  if (!isObject(parsed))
    throw new PublishCleanError(
      `Final npm tarball ${file} must contain a JSON object.`,
    );
  return parsed;
}

function npmPackTarballPath(output: string, packRoot: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch (cause) {
    throw new PublishCleanError("Unable to parse npm pack --json output.", {
      cause,
    });
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isObject(parsed[0]))
    throw new PublishCleanError(
      "npm pack --json did not describe one tarball.",
    );
  const filename = parsed[0].filename;
  if (typeof filename !== "string" || filename.length === 0)
    throw new PublishCleanError("npm pack --json did not report a filename.");
  return path.isAbsolute(filename) ? filename : path.join(packRoot, filename);
}

function pnpmPackTarballPath(output: string, packRoot: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch (cause) {
    throw new PublishCleanError("Unable to parse pnpm pack --json output.", {
      cause,
    });
  }
  if (!isObject(parsed))
    throw new PublishCleanError("pnpm pack --json did not describe a tarball.");
  const filename = parsed.filename;
  if (typeof filename !== "string" || filename.length === 0)
    throw new PublishCleanError("pnpm pack --json did not report a filename.");
  return path.isAbsolute(filename) ? filename : path.join(packRoot, filename);
}

function assertFinalTarballIncludesCleanedFiles(
  cleanedFiles: readonly string[],
  finalFiles: readonly string[],
): void {
  const missing = cleanedFiles
    .filter((file) => !finalFiles.includes(file))
    .sort();
  if (missing.length === 0) return;
  throw new PublishCleanError(
    `Final npm tarball dropped files from the cleaned package:\n${missing.join("\n")}`,
  );
}

function collectDeclaredPaths(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (const item of value) collectDeclaredPaths(item, out);
    return;
  }
  if (!isObject(value)) return;
  for (const item of Object.values(value)) collectDeclaredPaths(item, out);
}

function collectRelativeDeclaredPaths(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.startsWith("./") || value.startsWith("../")) out.push(value);
    return;
  }
  if (typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (const item of value) collectRelativeDeclaredPaths(item, out);
    return;
  }
  if (!isObject(value)) return;
  for (const item of Object.values(value))
    collectRelativeDeclaredPaths(item, out);
}

function normalizeDeclaredPath(declared: string): null | string {
  const withoutDot = declared.startsWith("./") ? declared.slice(2) : declared;
  if (!withoutDot || path.posix.isAbsolute(withoutDot)) return null;
  const normalized = path.posix.normalize(withoutDot);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../"))
    return null;
  return normalized;
}

function assertDeclaredFiles(pkg: JsonObject, packageDir: string): void {
  const paths: string[] = [];
  for (const field of ["main", "module", "types", "typings", "bin"]) {
    collectDeclaredPaths(pkg[field], paths);
  }
  if (typeof pkg.browser === "string") collectDeclaredPaths(pkg.browser, paths);
  else collectRelativeDeclaredPaths(pkg.browser, paths);
  for (const field of ["exports", "imports", "sideEffects"]) {
    collectRelativeDeclaredPaths(pkg[field], paths);
  }
  collectDeclaredPaths(pkg.typesVersions, paths);
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
  },
): Promise<void> {
  requireTool("pnpm");
  requireTool("npm");
  requireTool("tar");
  warnIfNonPnpmLifecycle();

  const sourcePkgPath = path.join(packageDir, "package.json");
  const sourcePkg = readJson(sourcePkgPath);
  if (!opts.guardOnly && !opts.dryRun)
    assertTrustedPublishingRuntime(sourcePkg, opts.publishArgs);
  const config = packageConfig(sourcePkg);
  const skipFileCheck = opts.skipFileCheck || config.skipFileCheck === true;
  const noGitChecks = opts.noGitChecks || config.noGitChecks === true;
  const registry =
    opts.registry ??
    (typeof config.registry === "string" ? config.registry : null);
  const extraDevFields = customDevFields(config);

  assertPublicPackage(sourcePkg);
  assertCleanGit(packageDir, noGitChecks);
  assertFilesField(sourcePkg, skipFileCheck);

  const root = await mkdtemp(path.join(tmpdir(), "publish-clean-"));
  let keepRoot = false;
  try {
    const packedOutput = run(
      "pnpm",
      ["pack", "--json", "--pack-destination", root],
      packageDir,
    );
    const tarball = pnpmPackTarballPath(packedOutput, root);
    run("tar", ["xzf", tarball, "-C", root], packageDir);

    const extracted = path.join(root, "package");
    const extractedStat = await stat(extracted);
    if (!extractedStat.isDirectory())
      throw new PublishCleanError(
        "Extracted tarball did not contain package/ directory.",
      );

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
    await writeFile(packedPkgPath, stringifyJson(cleanedPkg));
    assertDeclaredFiles(cleanedPkg, extracted);
    const cleanedFiles: string[] = [];
    await walkFiles(extracted, extracted, cleanedFiles);

    const finalPackRoot = path.join(root, "npm-pack");
    await mkdir(finalPackRoot);
    const npmPackOutput = run(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        finalPackRoot,
      ],
      extracted,
    );
    const finalTarball = npmPackTarballPath(npmPackOutput, finalPackRoot);
    const finalFiles = listTarballFiles(finalTarball, extracted);
    validatePackedFiles(finalFiles, skipFileCheck);
    assertFinalTarballIncludesCleanedFiles(cleanedFiles, finalFiles);
    const finalPkg = readTarballJson(finalTarball, "package.json", extracted);
    assertNoMonorepoProtocols(finalPkg);
    if (stableJson(finalPkg) !== stableJson(cleanedPkg))
      throw new PublishCleanError(
        "Final npm tarball manifest differs from the cleaned manifest.",
      );

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
    run("npm", publishArgs, extracted);
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
    },
    strict: true,
  });

  if (parsed.values.help) {
    console.log(
      "publish-clean [--dry-run] [--guard-only] [--no-git-checks] [--registry URL] [--skip-file-check] [package-dir] [-- npm-publish-args]",
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
    registry:
      typeof parsed.values.registry === "string"
        ? parsed.values.registry
        : null,
    skipFileCheck: parsed.values["skip-file-check"] === true,
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
