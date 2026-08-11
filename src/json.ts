/**
 * The manifest's shape, and the two serialisations this tool needs for two different jobs.
 */

/** A parsed JSON object. Deliberately not a manifest interface: this tool must carry fields it has never heard of. */
export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The form written into the published tarball: npm's own two-space indentation with a trailing
 * newline, and key order left exactly as the packer emitted it. Preserving order is what makes
 * the artifact byte-reproducible across runs, since cleaning only ever deletes keys.
 */
export function stringifyJson(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * The form used only to compare two manifests for equality. Key order carries no meaning to a
 * consumer, so comparing the written form would report a difference where none exists.
 */
export function stableJson(value: JsonObject): string {
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
