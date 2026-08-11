/**
 * Every decision this tool makes about what a published package carries, with no process,
 * filesystem or argv in reach. The split is not cosmetic: these are the rules that say what
 * ships, and each is worth exercising directly, one input to one output, rather than through
 * two package managers and a tarball. cli.ts owns the effects and wires them to these.
 *
 * Ambient inputs arrive as parameters, never by reaching for them: reading `process.env` from
 * here would make these cases depend on state a test can only set process-wide, which is both
 * a mock and a race against every case running beside it.
 */
import path from "node:path";

export type JsonObject = Record<string, unknown>;

export const DEV_FIELDS = new Set([
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
  // A packing instruction, spent once the tarball exists: the published artifact is that
  // tarball with its manifest replaced, so nothing re-derives a file set from this field, and
  // an install extracts every entry unfiltered. npm agrees — its registry normalisation drops
  // `files` from the served version document while keeping `exports` and `sideEffects`, which
  // are what actually resolve. Stripping it is safe ONLY while no second packer runs; a
  // pipeline that packs again from the cleaned directory would silently lose files, because
  // npm then falls back to `.gitignore`/`.npmignore` for exclusion.
  "files",
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

export const CONSUMER_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "uninstall",
]);

export const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
  "resolutions",
] as const;

export const MONOREPO_PROTOCOLS = ["catalog:", "workspace:", "link:", "portal:"];

/**
 * Fields a consumer's toolchain resolves. Stripping one breaks installs, imports or
 * platform gating, so `devFields` is not allowed to name them.
 */
export const RUNTIME_MANIFEST_FIELDS = new Set([
  ...DEP_FIELDS,
  "bin",
  "browser",
  "bundleDependencies",
  "bundledDependencies",
  "cpu",
  "engines",
  "exports",
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
export const REGISTRY_MANIFEST_FIELDS = new Set([
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
export function assertNoLostConsumerFields(
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

/**
 * Names the fields that survived cleaning without anyone recognising them.
 *
 * The strip list can only ever describe tools that existed when it was written, so every new
 * `package.json` key some tool invents ships to consumers until a human notices. This cannot
 * be fixed by keeping only recognised fields: that would silently drop a key some consumer
 * genuinely resolves, and the breakage would surface in a stranger's project rather than here.
 * So the field ships, and the maintainer is told it did, with the exact config that would drop
 * it next time. It is advice about the package, not an error in it — nothing about the
 * published artifact depends on whether anyone reads it.
 *
 * Returned rather than printed, so the message is this function's value and can be asserted
 * whole. Writing to `console` from here would make that assertion a spy on a process-wide
 * object, which two cases running side by side can clobber.
 */
export function unrecognizedFieldsReport(pkg: JsonObject, kept: readonly string[]): null | string {
  const acknowledged = new Set(kept);
  const unrecognized = Object.keys(pkg).filter(
    (field) =>
      !RUNTIME_MANIFEST_FIELDS.has(field) &&
      !REGISTRY_MANIFEST_FIELDS.has(field) &&
      !acknowledged.has(field),
  );
  if (unrecognized.length === 0) return null;
  return (
    `publish-clean: these manifest fields are not recognised and were published as-is:\n` +
    `${unrecognized.map((field) => `  ${field}`).join("\n")}\n` +
    `Strip the ones consumers do not read, and acknowledge the ones they do:\n` +
    `  "publish-clean": { "devFields": [${unrecognized.map((f) => `"${f}"`).join(", ")}] }\n` +
    `  "publish-clean": { "keepFields": [${unrecognized.map((f) => `"${f}"`).join(", ")}] }`
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
export const CRITICAL_PATTERNS = [
  /(?:^|\/)node_modules(?:\/|$)/i,
  /(?:^|\/)\.git(?:\/|$)/i,
  /(?:^|\/)\.env(?:\.|$)/i,
  /(?:^|\/)\.npmrc$/i,
  /\.(?:pem|key|p12|pfx|p8|ppk|jks|keystore)$/i,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i,
];

export const SUSPICIOUS_PATTERNS = [
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
export const PUBLISH_ADVISORY =
  "publish-clean packs with pnpm: it resolves workspace: and catalog: specs from the packing package's own node_modules, so a Bun workspace works as-is and a Yarn one needs a pnpm-workspace.yaml plus one pnpm install. npm packs those specs unresolved.";

export const MIN_TRUSTED_NPM_VERSION = [11, 5, 1] as const;

export class PublishCleanError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PublishCleanError";
  }
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringifyJson(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function stableJson(value: JsonObject): string {
  return JSON.stringify(stableValue(value));
}

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

export function isAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (const index of [0, 1, 2] as const) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

/**
 * The exact variables the publish decisions read, named so the dependency is visible in each
 * signature instead of reaching into the ambient process from a module that promises not to.
 * `process.env` satisfies this structurally, so the caller passes it and nothing else changes.
 */
export interface TrustedPublishEnv {
  ACTIONS_ID_TOKEN_REQUEST_URL?: string | undefined;
  GITHUB_ACTIONS?: string | undefined;
  GITHUB_REPOSITORY?: string | undefined;
}

export function wantsTrustedPublish(
  pkg: JsonObject,
  publishArgs: readonly string[],
  env: TrustedPublishEnv,
): boolean {
  if (publishArgs.includes("--provenance")) return true;
  if (isObject(pkg.publishConfig) && pkg.publishConfig.provenance === true) return true;
  // Actions defines the token URL only when the job requests `id-token: write`, which is
  // precisely the permission that makes an unflagged publish produce provenance.
  return env.GITHUB_ACTIONS === "true" && typeof env.ACTIONS_ID_TOKEN_REQUEST_URL === "string";
}

export function assertPublicPackage(pkg: JsonObject): void {
  if (pkg.private === true)
    throw new PublishCleanError("Refusing to publish a package with private: true.");
}

export function repositoryUrl(pkg: JsonObject): null | string {
  if (typeof pkg.repository === "string") return pkg.repository;
  if (isObject(pkg.repository) && typeof pkg.repository.url === "string") return pkg.repository.url;
  return null;
}

export function githubRepositorySlug(url: string): null | string {
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

export function assertRepositoryForTrustedPublish(
  pkg: JsonObject,
  publishArgs: readonly string[],
  env: TrustedPublishEnv,
): void {
  if (!wantsTrustedPublish(pkg, publishArgs, env)) return;
  if (env.GITHUB_ACTIONS !== "true" || typeof env.GITHUB_REPOSITORY !== "string") return;
  const repoUrl = repositoryUrl(pkg);
  if (!repoUrl)
    throw new PublishCleanError(
      "GitHub trusted publishing requires package.json repository.url to match GITHUB_REPOSITORY.",
    );
  const slug = githubRepositorySlug(repoUrl);
  if (slug !== env.GITHUB_REPOSITORY)
    throw new PublishCleanError(
      `package.json repository.url must match GITHUB_REPOSITORY (${env.GITHUB_REPOSITORY}); found ${repoUrl}.`,
    );
}

export function stripManifest(pkg: JsonObject, extraDevFields: readonly string[]): JsonObject {
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
 * Pins the published manifest to a registry, when one was chosen.
 *
 * Written into `publishConfig` rather than passed only on the command line, because that is
 * where npm looks when someone later republishes the same tarball by hand — the artifact then
 * carries its own destination instead of depending on whoever runs the command. Any other
 * `publishConfig` keys the author set are consumer-facing and survive untouched.
 *
 * Returns the manifest unchanged when no registry was chosen, so the caller has no branch and
 * cannot forget one.
 */
export function withRegistry(pkg: JsonObject, registry: null | string): JsonObject {
  if (registry === null) return pkg;
  const publishConfig = isObject(pkg.publishConfig) ? { ...pkg.publishConfig } : {};
  publishConfig.registry = registry;
  return { ...pkg, publishConfig };
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
export function assertNoMonorepoProtocols(pkg: JsonObject): void {
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

export function customDevFields(config: JsonObject): string[] {
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
export function keptFields(config: JsonObject): readonly string[] {
  if (!Array.isArray(config.keepFields)) return [];
  return config.keepFields.filter((field): field is string => typeof field === "string");
}

export function assertFilesField(pkg: JsonObject, skip: boolean): void {
  if (skip) return;
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    throw new PublishCleanError('Package manifest must define a non-empty "files" array.');
  }
}

export function validatePackedFiles(files: readonly string[], skipSuspicious: boolean): void {
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
export function collectDeclaredPaths(
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

export function normalizeDeclaredPath(declared: string): null | string {
  const withoutDot = declared.startsWith("./") ? declared.slice(2) : declared;
  if (!withoutDot || path.posix.isAbsolute(withoutDot)) return null;
  const normalized = path.posix.normalize(withoutDot);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

export function packageConfig(pkg: JsonObject): JsonObject {
  const config = pkg["publish-clean"];
  return isObject(config) ? config : {};
}
