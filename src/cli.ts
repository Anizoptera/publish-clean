import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
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
const CRITICAL_PATTERNS = [/^node_modules(?:\/|$)/, /^\.git(?:\/|$)/, /^\.env(?:\.|$)/, /^\.npmrc$/, /\.(?:pem|key|p12|pfx)$/];
const SUSPICIOUS_PATTERNS = [
  /(?:^|\/)(?:test|tests|__tests__|__snapshots__|coverage)(?:\/|$)/,
  /(?:^|\/)\.github(?:\/|$)/,
  /(?:^|\/)tsconfig[^/]*\.json$/,
  /(?:^|\/)(?:pnpm-lock\.yaml|bun\.lock|package-lock\.json)$/,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
];

const PUBLISH_ADVISORY =
  "publish-clean uses pnpm pack intentionally; npm, yarn, and bun pack do not reliably normalize pnpm workspace/catalog manifests.";

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
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!isObject(parsed)) throw new PublishCleanError(`${file} must contain a JSON object.`);
  return parsed;
}

function stringifyJson(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function requireTool(name: string): void {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
  } catch (cause) {
    throw new PublishCleanError(`Required tool "${name}" is not available in PATH.`, { cause });
  }
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
    throw new PublishCleanError("Unable to verify source git status.", { cause: error });
  }
}

function assertPublicPackage(pkg: JsonObject): void {
  if (pkg.private === true) throw new PublishCleanError("Refusing to publish a package with private: true.");
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

function assertNoMonorepoProtocols(pkg: JsonObject): void {
  const failures: string[] = [];
  for (const field of DEP_FIELDS) {
    const map = pkg[field];
    if (!isObject(map)) continue;
    for (const [name, spec] of Object.entries(map)) {
      if (typeof spec !== "string") continue;
      if (MONOREPO_PROTOCOLS.some((prefix) => spec.includes(prefix))) failures.push(`${field}.${name}: ${spec}`);
    }
  }
  const pnpm = pkg.pnpm;
  if (isObject(pnpm) && isObject(pnpm.overrides)) {
    for (const [name, spec] of Object.entries(pnpm.overrides)) {
      if (typeof spec === "string" && MONOREPO_PROTOCOLS.some((prefix) => spec.includes(prefix))) failures.push(`pnpm.overrides.${name}: ${spec}`);
    }
  }

  if (failures.length > 0) {
    throw new PublishCleanError(`Packed manifest contains unresolved monorepo-only dependency specs:\n${failures.join("\n")}\n${PUBLISH_ADVISORY}`);
  }
}

async function walk(dir: string, root: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    files.push(relative);
    if (entry.isDirectory()) await walk(absolute, root, files);
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
  if (critical.length > 0) throw new PublishCleanError(`Critical files must not be published:\n${critical.join("\n")}`);
  if (skipSuspicious) return;

  const suspicious = files.filter((file) => SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(file)));
  if (suspicious.length > 0) throw new PublishCleanError(`Suspicious files in package artifact:\n${suspicious.join("\n")}`);
}

function collectDeclaredPaths(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.startsWith("./")) out.push(value.slice(2));
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

function assertDeclaredFiles(pkg: JsonObject, packageDir: string): void {
  const paths: string[] = [];
  for (const field of ["main", "module", "types", "typings", "exports", "imports", "browser", "bin", "typesVersions", "sideEffects"]) {
    collectDeclaredPaths(pkg[field], paths);
  }
  const missing = paths.filter((declared) => !declared.includes("*") && !exists(path.join(packageDir, declared)));
  if (missing.length > 0) throw new PublishCleanError(`Manifest declares files missing from packed artifact:\n${missing.join("\n")}`);
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

async function packAndClean(packageDir: string, opts: { dryRun: boolean; guardOnly: boolean; noGitChecks: boolean; registry: null | string; skipFileCheck: boolean }) {
  requireTool("pnpm");
  requireTool("tar");
  warnIfNonPnpmLifecycle();

  const sourcePkgPath = path.join(packageDir, "package.json");
  const sourcePkg = readJson(sourcePkgPath);
  const config = packageConfig(sourcePkg);
  const skipFileCheck = opts.skipFileCheck || config.skipFileCheck === true;
  const noGitChecks = opts.noGitChecks || config.noGitChecks === true;
  const registry = opts.registry ?? (typeof config.registry === "string" ? config.registry : null);
  const extraDevFields = Array.isArray(config.devFields) ? config.devFields.filter((field): field is string => typeof field === "string") : [];

  assertPublicPackage(sourcePkg);
  assertCleanGit(packageDir, noGitChecks || opts.guardOnly);
  assertFilesField(sourcePkg, skipFileCheck);

  const root = await mkdtemp(path.join(tmpdir(), "publish-clean-"));
  const packedName = run("pnpm", ["pack", "--pack-destination", root], packageDir).trim().split("\n").at(-1);
  if (!packedName) throw new PublishCleanError("pnpm pack did not report a tarball path.");
  const tarball = path.isAbsolute(packedName) ? packedName : path.join(root, packedName);
  run("tar", ["xzf", tarball, "-C", root], packageDir);

  const extracted = path.join(root, "package");
  const extractedStat = await stat(extracted);
  if (!extractedStat.isDirectory()) throw new PublishCleanError("Extracted tarball did not contain package/ directory.");

  const files: string[] = [];
  await walk(extracted, extracted, files);
  validatePackedFiles(files, skipFileCheck);

  const packedPkgPath = path.join(extracted, "package.json");
  const cleanedPkg = stripManifest(readJson(packedPkgPath), extraDevFields);
  if (registry) {
    const publishConfig = isObject(cleanedPkg.publishConfig) ? { ...cleanedPkg.publishConfig } : {};
    publishConfig.registry = registry;
    cleanedPkg.publishConfig = publishConfig;
  }
  assertNoMonorepoProtocols(cleanedPkg);
  await writeFile(packedPkgPath, stringifyJson(cleanedPkg));
  assertDeclaredFiles(cleanedPkg, extracted);

  if (opts.guardOnly || opts.dryRun) {
    console.log(`[dry-run] Extracted package at: ${extracted}`);
    return { extracted, root };
  }

  const extra = process.argv.includes("--") ? process.argv.slice(process.argv.indexOf("--") + 1) : [];
  run("pnpm", ["publish", "--no-git-checks", ...extra], extracted);
  await rm(root, { recursive: true, force: true });
  return { extracted, root };
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      "guard-only": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      "no-git-checks": { type: "boolean", default: false },
      registry: { type: "string", default: undefined },
      "skip-file-check": { type: "boolean", default: false },
    },
    strict: false,
  });

  if (parsed.values.help) {
    console.log("publish-clean [--dry-run] [--guard-only] [--registry URL] [--skip-file-check] [package-dir] [-- pnpm-publish-args]");
    return;
  }

  const packageDir = path.resolve(String(parsed.positionals[0] ?? "."));
  const result = await packAndClean(packageDir, {
    dryRun: parsed.values["dry-run"] === true,
    guardOnly: parsed.values["guard-only"] === true,
    noGitChecks: parsed.values["no-git-checks"] === true,
    registry: typeof parsed.values.registry === "string" ? parsed.values.registry : null,
    skipFileCheck: parsed.values["skip-file-check"] === true,
  });
  if (!parsed.values["dry-run"] && !parsed.values["guard-only"]) rmSync(result.root, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`publish-clean: ${message}`);
  process.exitCode = 1;
});
