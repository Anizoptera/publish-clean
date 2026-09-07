/**
 * Preserve manifest values and property order when writing the published artifact.
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
