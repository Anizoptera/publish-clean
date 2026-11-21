// Validate package configuration before it can change what gets published.
import { PublishCleanError } from "./error";
import { isObject } from "./json";
import type { JsonObject } from "./json";
import { RUNTIME_MANIFEST_FIELDS } from "./manifest";
import { assertRegistry } from "./registry";

/**
 * Every key this tool reads out of the manifest's `publish-clean` block. Naming them is what
 * makes a typo an error instead of a silent no-op — and a silent no-op here is not cosmetic:
 * `devFeilds` publishes the field the author meant to strip, and nothing in the output says so.
 */
const CONFIG_KEYS = new Set([
  "allowSuspicious",
  "allowUnreferenced",
  "devFields",
  "heal",
  "keepFields",
  "noGitChecks",
  "registry",
  "renameFiles",
  "skipFileCheck",
  "validateArtifact",
]);

export function packageConfig(pkg: JsonObject): JsonObject {
  const config = pkg["publish-clean"];
  if (config === undefined) return {};
  if (!isObject(config)) throw new PublishCleanError('"publish-clean" must be an object.');
  const unknown = Object.keys(config).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length > 0)
    throw new PublishCleanError(
      `Unknown "publish-clean" manifest options:\n${unknown.join("\n")}\n` +
        `Valid options: ${[...CONFIG_KEYS].join(", ")}`,
    );
  for (const key of ["allowSuspicious", "heal", "noGitChecks", "skipFileCheck"])
    if (config[key] !== undefined && typeof config[key] !== "boolean")
      throw new PublishCleanError(`publish-clean.${key} must be a boolean.`);
  if (config.registry !== undefined) assertRegistry(config.registry);
  stringList(config, "devFields");
  stringList(config, "keepFields");
  stringList(config, "allowUnreferenced");
  renamedFiles(config);
  if (config.validateArtifact !== undefined) {
    const argv = stringList(config, "validateArtifact");
    if (!argv[0]?.trim() || argv.some((argument) => argument.includes("\0")))
      throw new PublishCleanError(
        "publish-clean.validateArtifact must contain an executable followed by optional arguments, without NUL bytes.",
      );
  }
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

/**
 * Shipped files the author has confirmed are used in a way no import records — a binary a native
 * loader finds by path, a directory read at run time, a UI asset served over HTTP.
 *
 * The reachability check is an error, so without this an author whose package is legitimately
 * shaped that way could never publish. A prefix matches a whole subtree, because these arrive in
 * directories: `lib/vite/` is one line where naming each of 63 generated asset files is not a
 * list anyone will maintain.
 */
export function allowedUnreferenced(config: JsonObject): readonly string[] {
  return stringList(config, "allowUnreferenced");
}

/**
 * Packed files the author ships under another name: `{ "AGENTS.consumer.md": "AGENTS.md" }`.
 *
 * Exists for a package whose root is its repository root, where the name a consumer must find is
 * already taken by a file that must not ship — maintainer agent rules in `AGENTS.md` beside the
 * consumer copy. A `prepack` copy cannot help there, because the destination already exists in the
 * tree pnpm packs. Paths are written as pnpm packs them, relative to the package root, so the name
 * the author types is the name a finding prints.
 *
 * Every shape whose meaning a rename could not state unambiguously is refused here, before the pack:
 * an absolute, `.`/`..` or backslash path could land a member outside `package/`; the manifest is the
 * one member this tool rewrites; two sources sharing a target would ship one file where the author
 * listed two; and a target that is also a source makes the result depend on the order renames run.
 */
export function renamedFiles(config: JsonObject): ReadonlyMap<string, string> {
  const value = config.renameFiles;
  if (value === undefined) return new Map();
  if (!isObject(value) || Object.values(value).some((target) => typeof target !== "string"))
    throw new PublishCleanError(
      'publish-clean.renameFiles must be an object mapping a packed path to its published path, e.g. { "AGENTS.consumer.md": "AGENTS.md" }.',
    );
  const renames = new Map(Object.entries(value as Record<string, string>));
  const problems: string[] = [];
  const targets = new Map<string, string>();
  for (const [source, target] of renames) {
    for (const name of [source, target])
      if (!isPackagePath(name))
        problems.push(
          `${JSON.stringify(name)} is not a relative file path inside the package (no leading "/" or "./", no "." or ".." segments, no "\\", no trailing "/").`,
        );
      else if (name === "package.json")
        problems.push("package.json cannot be renamed: it is the manifest this tool rewrites.");
    if (source === target) problems.push(`${JSON.stringify(source)} is renamed to itself.`);
    const earlier = targets.get(target);
    if (earlier !== undefined)
      problems.push(
        `${JSON.stringify(earlier)} and ${JSON.stringify(source)} are both renamed to ${JSON.stringify(target)}.`,
      );
    targets.set(target, source);
    if (source !== target && renames.has(target))
      problems.push(
        `${JSON.stringify(target)} is both a rename target and a rename source, so the result would depend on the order renames run.`,
      );
  }
  if (problems.length > 0)
    throw new PublishCleanError(`publish-clean.renameFiles:\n${[...new Set(problems)].join("\n")}`);
  return renames;
}

function isPackagePath(name: string): boolean {
  const parts = name.split("/");
  return (
    name.length > 0 &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    parts.every((part) => part !== "" && part !== "." && part !== "..")
  );
}
