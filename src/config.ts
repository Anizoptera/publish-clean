// Validate package configuration before it can change what gets published.
import { PublishCleanError } from "./error";
import { isObject } from "./json";
import type { JsonObject } from "./json";
import { RUNTIME_MANIFEST_FIELDS, assertRegistry } from "./manifest";

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
  for (const key of ["allowSuspicious", "noGitChecks", "skipFileCheck"])
    if (config[key] !== undefined && typeof config[key] !== "boolean")
      throw new PublishCleanError(`publish-clean.${key} must be a boolean.`);
  if (config.registry !== undefined) assertRegistry(config.registry);
  stringList(config, "devFields");
  stringList(config, "keepFields");
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
