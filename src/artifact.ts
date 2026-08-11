/**
 * What the published tarball may carry, and what it must. Every rule here judges a file list —
 * the archive's entry paths with the `package/` prefix already stripped — never a directory on
 * disk, because that list is what a consumer's installer unpacks and it needs no filesystem to
 * exist.
 *
 * Ambient inputs arrive as parameters and never by reaching for them — no process, filesystem or
 * argv here. `cli.ts` owns the effects.
 */
import path from "node:path";

import { PublishCleanError } from "./error";
import { isObject } from "./json";
import type { JsonObject } from "./json";

/**
 * Content that must never reach a registry. `^` means the package root.
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
 * Refuses a rewritten tarball whose file set is not the packed one, entry for entry.
 *
 * Replacing a member is supposed to change one member, and the rewriter copies every other
 * entry as opaque bytes — so this can only fail through a defect in that code, which is exactly
 * why it is worth asserting on the step that cannot be taken back. Nothing else would notice a
 * dropped file: the leak checks only ask what is present, and a package missing a file installs
 * fine and then fails at import, on a version the registry keeps forever.
 *
 * The two lists come from the same reader, so this cannot catch a defect in the reader itself —
 * only one in the rewrite, which is what it is for. Independence from the reader is bought
 * elsewhere, by the case in test/cli.test.ts that compares the list this reader prints against
 * `tar tzf` of the same tarball — an instrument that cannot share a mistake with this one.
 */
export function assertSameEntries(packed: readonly string[], published: readonly string[]): void {
  const before = new Set(packed);
  const after = new Set(published);
  const changed = [
    ...packed.filter((file) => !after.has(file)).map((file) => `- ${file}`),
    ...published.filter((file) => !before.has(file)).map((file) => `+ ${file}`),
  ];
  if (changed.length > 0)
    throw new PublishCleanError(
      `Rewriting the tarball manifest changed its file set:\n${changed.join("\n")}`,
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

/**
 * Refuses a manifest whose declared entry points are not in the tarball.
 *
 * A path containing `*` is skipped: `exports` subpath patterns and `typesVersions` globs stand
 * for a set of files, and resolving them here would mean reimplementing npm's own matcher to
 * answer a question npm answers at install time.
 */
export function assertDeclaredFiles(pkg: JsonObject, published: readonly string[]): void {
  const declared: string[] = [];
  for (const field of ["main", "module", "types", "typings", "bin"])
    collectDeclaredPaths(pkg[field], declared, "every-string");
  // `browser` is two fields sharing a name: a string is the replacement entry point, an
  // object is a map whose values may be `false` or another package's name.
  if (typeof pkg.browser === "string") collectDeclaredPaths(pkg.browser, declared, "every-string");
  else collectDeclaredPaths(pkg.browser, declared, "relative-only");
  for (const field of ["exports", "imports", "sideEffects"])
    collectDeclaredPaths(pkg[field], declared, "relative-only");
  collectDeclaredPaths(pkg.typesVersions, declared, "every-string");

  const resolved = declared.map((declaredPath) => ({
    path: declaredPath,
    normalized: normalizeDeclaredPath(declaredPath),
  }));
  const invalid = resolved.filter((item) => item.normalized === null);
  if (invalid.length > 0)
    throw new PublishCleanError(
      `Manifest declares invalid package paths:\n${invalid.map((item) => item.path).join("\n")}`,
    );

  const shipped = new Set(published);
  const missing = resolved.filter(
    (item) => !item.path.includes("*") && !shipped.has(String(item.normalized)),
  );
  if (missing.length > 0)
    throw new PublishCleanError(
      `Manifest declares files missing from packed artifact:\n${missing.map((item) => item.path).join("\n")}`,
    );
}
