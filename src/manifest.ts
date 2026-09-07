/**
 * What the published `package.json` carries: which fields survive cleaning, which are refused,
 * and what the author may add to either list.
 *
 * Ambient inputs arrive as parameters and never by reaching for them — no process, filesystem or
 * argv here — so every rule is one input to one output. `cli.ts` owns the effects.
 */
import { PublishCleanError } from "./error";
import { normalizeDeclaredPath } from "./artifact";
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
  // Both the source and packed manifests are checked before stripping: pack hooks can
  // change this flag, and removing it first would bypass the refusal.
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
  "config",
  "deno",
  "directories",
  "jsdelivr",
  "man",
  "react-native",
  "sass",
  "style",
  "styleModule",
  "svelte",
  "unpkg",
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

/** Registry metadata is recognised; consumer-resolved fields are protected separately. */
export const REGISTRY_MANIFEST_FIELDS = new Set([
  "author",
  "bugs",
  "contributors",
  "description",
  "funding",
  "gitHead",
  "homepage",
  "keywords",
  "maintainers",
  "preferGlobal",
  "repository",
  "scripts",
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

/** npm gives a scope registry priority over the general registry setting. */
export function packageScope(pkg: JsonObject): string | null {
  if (typeof pkg.name !== "string" || !pkg.name.startsWith("@")) return null;
  const slash = pkg.name.indexOf("/");
  return slash > 1 ? pkg.name.slice(0, slash) : null;
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
/** A misspelled registry must fail locally rather than fall back to a public destination. */
export function assertRegistry(value: unknown): asserts value is string {
  try {
    if (typeof value !== "string" || !value.trim()) throw new Error("Expected a URL");
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Expected HTTP(S)");
  } catch (cause) {
    throw new PublishCleanError("Registry must be an absolute HTTP(S) URL.", { cause });
  }
}

export function withRegistry(pkg: JsonObject, registry: null | string): JsonObject {
  if (registry === null) return pkg;
  assertRegistry(registry);
  const publishConfig = isObject(pkg.publishConfig) ? { ...pkg.publishConfig } : {};
  publishConfig.registry = registry;
  const scope = packageScope(pkg);
  if (scope) publishConfig[`${scope}:registry`] = registry;
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
  const quoted = unrecognized.map((field) => JSON.stringify(field));
  const list = quoted.join(", ");
  return (
    `publish-clean: these manifest fields are not recognised and are retained as-is:\n` +
    `  ${quoted.join("\n  ")}\n` +
    `Strip the ones consumers do not read, and acknowledge the ones they do:\n` +
    `  "publish-clean": { "devFields": [${list}] }\n` +
    `  "publish-clean": { "keepFields": [${list}] }`
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
export function assertNoMonorepoProtocols(pkg: JsonObject, files: readonly string[] = []): void {
  const failures: string[] = [];
  const shipped = new Set(files);
  for (const field of DEP_FIELDS) {
    const map = pkg[field];
    if (!isObject(map)) continue;
    for (const [name, spec] of Object.entries(map)) {
      if (typeof spec !== "string") continue;
      const resolved = spec.startsWith("npm:") ? spec.slice(spec.lastIndexOf("@") + 1) : spec;
      if (MONOREPO_PROTOCOLS.some((prefix) => resolved.startsWith(prefix)))
        failures.push(`${field}.${name}: ${spec}`);
      // A file dependency is portable only when its target travels inside this tarball.
      // npm can install a shipped vendor directory; rejecting every file: spec would break it.
      if (/^(?:file:|git\+file:|\.{1,2}(?:[\\/]|$)|\/|~[\\/]|[a-z]:[\\/])/i.test(spec)) {
        let local: string | null = null;
        try {
          local = normalizeDeclaredPath(decodeURIComponent(spec.replace(/^file:/i, "")));
        } catch {
          /* A malformed URI cannot name a portable packed dependency. */
        }
        if (
          !local ||
          /[\\]/.test(local) ||
          /^(?:git\+file:|~[\\/]|(?:file:)?[a-z]:[\\/])/i.test(spec) ||
          !(
            (/\.(?:tgz|tar\.gz|tar)$/.test(local) && shipped.has(local)) ||
            shipped.has(`${local}/package.json`)
          )
        )
          failures.push(`${field}.${name}: ${spec} (local target is not in the artifact)`);
      }
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
  if (
    !Array.isArray(pkg.files) ||
    pkg.files.length === 0 ||
    pkg.files.some((file) => typeof file !== "string" || !file.trim())
  ) {
    throw new PublishCleanError(
      'Package manifest must define a non-empty "files" array of non-empty strings.',
    );
  }
}
