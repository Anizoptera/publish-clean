/**
 * What the published `package.json` carries: which fields survive cleaning, which are refused,
 * and what the author may add to either list.
 *
 * Ambient inputs arrive as parameters and never by reaching for them — no process, filesystem or
 * argv here — so every rule is one input to one output. `cli.ts` owns the effects.
 */
import { PublishCleanError } from "./error";
import { isObject } from "./json";
import type { JsonObject } from "./json";

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
 * Refuses a published manifest that lost a field the source declared and consumers read.
 *
 * Every other check here asks whether something got in that should not have. This asks the
 * opposite, and nothing else does: cleaning is subtraction, so the way it fails is by
 * taking too much. A dropped `repository` breaks provenance verification, a dropped
 * `exports` makes the package unimportable, and neither leaves any trace in the artifact
 * to notice later. The registry keeps the version forever either way.
 *
 * Read out of the published tarball rather than from the cleaned value in memory, so a loss
 * introduced while rewriting the archive is caught as well as one introduced by stripping.
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
 * Refuses a manifest that still carries a spec only a workspace can resolve. Published
 * with one, the package is uninstallable for everyone, and the version cannot be taken
 * back.
 *
 * The caller passes an already-stripped manifest, so the dev-only members of DEP_FIELDS are
 * absent by construction. They are still checked, because a guard whose correctness depends on
 * the order it happens to be called in fails silently the day someone reorders it.
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

export function assertPublicPackage(pkg: JsonObject): void {
  if (pkg.private === true)
    throw new PublishCleanError("Refusing to publish a package with private: true.");
}

export function assertFilesField(pkg: JsonObject, skip: boolean): void {
  if (skip) return;
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    throw new PublishCleanError('Package manifest must define a non-empty "files" array.');
  }
}

/**
 * Every key this tool reads out of the manifest's `publish-clean` block. Naming them is what
 * makes a typo an error instead of a silent no-op — and a silent no-op here is not cosmetic:
 * `devFeilds` publishes the field the author meant to strip, and nothing in the output says so.
 */
const CONFIG_KEYS = new Set([
  "allowSuspicious",
  "devFields",
  "keepFields",
  "noGitChecks",
  "registry",
  "skipFileCheck",
]);

export function packageConfig(pkg: JsonObject): JsonObject {
  const config = pkg["publish-clean"];
  if (!isObject(config)) return {};
  const unknown = Object.keys(config).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length > 0)
    throw new PublishCleanError(
      `Unknown "publish-clean" manifest options:\n${unknown.join("\n")}\n` +
        `Valid options: ${[...CONFIG_KEYS].join(", ")}`,
    );
  return config;
}

/**
 * Reads a string-list option, refusing anything else outright rather than filtering it out.
 * A number or a nested object in this list is a mistake in the manifest, and skipping it
 * silently means the author's intent is lost with no signal anywhere.
 */
function stringList(config: JsonObject, key: string): readonly string[] {
  const value = config[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new PublishCleanError(`publish-clean.${key} must be an array of strings.`);
  return value as readonly string[];
}

export function customDevFields(config: JsonObject): readonly string[] {
  const fields = stringList(config, "devFields");
  const kept = new Set(stringList(config, "keepFields"));
  const contradictory = fields.filter((field) => kept.has(field));
  if (contradictory.length > 0)
    throw new PublishCleanError(
      `These fields are listed as both devFields and keepFields, which asks to strip and to publish the same key:\n${contradictory.join("\n")}`,
    );
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
  return stringList(config, "keepFields");
}
