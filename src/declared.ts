/**
 * What the manifest DECLARES must exist in the archive, and whether it does.
 *
 * The opposite direction from `artifact.ts`, which judges what the archive may CARRY. The two
 * were one file and two consumers: `shipped.ts` and `manifest.ts` each import only from this
 * half, because a path a manifest names is a question about reachability, where a packed
 * `.env` is a question about content. A miss here breaks a stranger's build with an artifact
 * that installs perfectly, so the failures it must not produce are the FALSE ones — every
 * near-match rule below exists to tell "you renamed it" from "it was never built".
 *
 * Ambient inputs arrive as parameters and never by reaching for them — no process, filesystem
 * or argv here. `cli.ts` owns the effects.
 */
import path from "node:path";

import { PublishCleanError } from "./error";
import { isObject } from "./json";
import type { JsonObject } from "./json";
import { foldName } from "./packed-names";

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
 * - `"relative-only"` for `sideEffects` and the object form of
 *   `browser`, where a string may just as well be an external package name, a condition
 *   target or a glob. Only a `./` or `../` prefix marks it as a path here. Collecting the
 *   rest would report a missing file for something that was never a file.
 *
 * Booleans are skipped rather than ignored by accident: `sideEffects: false` and
 * `browser` replacements legitimately hold them. Export/import targets use their own walker.
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

/** Node replaces every target star with the same subpath, including slashes. */
function matchesTarget(file: string, pattern: string): boolean {
  const parts = pattern.split("*");
  const count = parts.length - 1;
  if (count === 0) return file === pattern;
  const size = (file.length - parts.reduce((sum, part) => sum + part.length, 0)) / count;
  if (!Number.isInteger(size) || size < 0) return false;
  const start = parts[0]?.length ?? 0;
  return parts.join(file.slice(start, start + size)) === file;
}

interface DeclaredFile {
  name: string;
  kind: "file" | "main" | "types" | "target" | "glob";
  pattern: boolean;
}

/** Arrays skip invalid targets, but package-configuration errors must escape the fallback. */
class InvalidPackageTarget extends PublishCleanError {}

/** Export targets are URLs, unlike legacy main/bin paths; normalization must not hide invalid segments. */
function targetPath(target: string): string {
  if (!target.startsWith("./") || /%2f|%5c/i.test(target))
    throw new InvalidPackageTarget(
      `Manifest declares invalid package paths: ${JSON.stringify(target)}`,
    );
  try {
    const decoded = decodeURIComponent(target.split(/[?#]/, 1)[0] ?? "");
    if (
      decoded
        .slice(2)
        .split(/[\\/]/)
        .some((segment) => [".", "..", "node_modules"].includes(segment.toLowerCase()))
    )
      throw new Error("Invalid target segment");
    return decodeURIComponent(new URL(target, "file:///package/").pathname).slice(
      "/package/".length,
    );
  } catch (cause) {
    throw new InvalidPackageTarget(
      `Manifest declares invalid package paths: ${JSON.stringify(target)}`,
      { cause },
    );
  }
}

/** True selects a target, null blocks a condition, undefined leaves later conditions reachable. */
function collectTargets(
  value: unknown,
  imports: boolean,
  pattern: boolean,
  out: DeclaredFile[],
): true | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") {
    if (imports && !value.startsWith(".") && !value.startsWith("/")) return true;
    out.push({ name: targetPath(value), kind: "target", pattern });
    return true;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    let invalid: InvalidPackageTarget | null | undefined;
    for (const item of value) {
      try {
        const result = collectTargets(item, imports, pattern, out);
        if (result === true) return true;
        // Unlike condition objects, arrays continue after null and clear an earlier error.
        if (result === null) invalid = null;
      } catch (error) {
        if (!(error instanceof InvalidPackageTarget)) throw error;
        invalid = error;
      }
    }
    if (invalid) throw invalid;
    return invalid;
  }
  if (!isObject(value))
    throw new InvalidPackageTarget(
      "Invalid exports/imports target; expected a path, condition object, array or null.",
    );
  const conditions = Object.entries(value);
  // Node rejects numeric condition names before choosing any branch, including default.
  for (const [condition] of conditions) {
    const number = Number(condition);
    if (String(number) === condition && number >= 0 && number < 0xffff_ffff)
      throw new PublishCleanError(`Invalid export condition: ${JSON.stringify(condition)}.`);
  }
  for (const [condition, item] of conditions) {
    const definite = collectTargets(item, imports, pattern, out);
    if (condition === "default" && definite !== undefined) return definite;
  }
  return undefined;
}

function collectMap(value: unknown, imports: boolean, out: DeclaredFile[]): void {
  if (value === undefined || value === null) return;
  if (imports && !isObject(value)) throw new PublishCleanError("imports must be a subpath map.");
  const subpaths =
    isObject(value) && (imports || Object.keys(value).some((key) => key.startsWith(".")));
  if (!subpaths) {
    collectTargets(value, imports, false, out);
    return;
  }
  for (const [key, target] of Object.entries(value)) {
    if (
      imports
        ? !key.startsWith("#") || key === "#" || key.startsWith("#/")
        : key !== "." && !key.startsWith("./")
    )
      throw new PublishCleanError(`Invalid exports/imports key: ${JSON.stringify(key)}.`);
    collectTargets(target, imports, key.includes("*"), out);
  }
}

/** A CommonJS main tries file extensions and index files, not a nested package's main. */
function mainExists(name: string, files: ReadonlySet<string>): boolean {
  const file = (target: string) =>
    ["", ".js", ".json", ".node"].some((ext) => files.has(target + ext));
  if (file(name)) return true;
  const prefix = name ? `${name}/` : "";
  return [".js", ".json", ".node"].some((extension) => files.has(`${prefix}index${extension}`));
}

/**
 * The archive entry a missing target almost names.
 *
 * Case and Unicode form are the two ways a target can be wrong and still resolve on the machine
 * that wrote it: macOS matches `./dist/Index.js` to `dist/index.js` and a decomposed target to the
 * composed name `readdir` reports. Case-sensitivity is NOT the discriminator for both: measured
 * across exFAT, default APFS and a case-sensitive APFS volume, only the case-sensitive one refused
 * the wrong case, and every one of them still resolved the wrong Unicode form. That says nothing
 * about form elsewhere — macOS may normalise in its VFS rather than per filesystem, so the
 * instrument cannot separate them, and a filesystem that normalises nothing is unmeasured here.
 * Hence the report names no platform: both differences are reported the same way because both work
 * for their author, which is why nobody catches either. The report is the only place this is
 * recoverable: told merely that the file is "missing", an author looking straight at it hunts a
 * build that is working.
 *
 * Runs only for a target already proven absent, so the usual path allocates nothing.
 */
function nearMatch(name: string, published: readonly string[]): string | undefined {
  const folded = foldName(name);
  return published.find((file) => foldName(file) === folded);
}

/**
 * Validate declared files using each field's consumer semantics, without extracting the archive.
 *
 * THROWS rather than reporting a finding, which is the deliberate exception to this project's
 * "every defect in the examined package is a finding" rule. A missing declared file means the file
 * set itself is incomplete, so every later check reasons from a set it cannot trust and starts
 * producing advice that is wrong: with `dist` unpacked, the reachability scan sees the remaining
 * shipped sources reaching nothing and tells the author to declare them unreferenced, when the fix
 * is to pack `dist`. Stopping here is what makes the rest of the report trustworthy.
 */
export function assertDeclaredFiles(pkg: JsonObject, published: readonly string[]): void {
  const declared: DeclaredFile[] = [];
  const collect = (
    value: unknown,
    kind: DeclaredFile["kind"],
    mode: "every-string" | "relative-only" = "every-string",
    patterns = false,
  ) => {
    const names: string[] = [];
    collectDeclaredPaths(value, names, mode);
    declared.push(
      ...names.map((name) => ({ name, kind, pattern: patterns && name.includes("*") })),
    );
  };
  collect(pkg.main, "main");
  for (const field of ["types", "typings"]) collect(pkg[field], "types");
  collect(pkg.typesVersions, "types", "every-string", true);
  for (const field of ["module", "bin"]) collect(pkg[field], "file");
  collect(pkg.browser, "file", typeof pkg.browser === "string" ? "every-string" : "relative-only");
  collect(pkg.sideEffects, "glob", "relative-only");
  collectMap(pkg.exports, false, declared);
  collectMap(pkg.imports, true, declared);
  const files = new Set(published);
  const missing: string[] = [];
  for (const item of declared) {
    // Bundler globs select any matching modules; they need not select a shipped file.
    // https://webpack.js.org/guides/tree-shaking/#mark-the-file-as-side-effect-free
    if (item.kind === "glob" && /[*?[\]{}]/.test(item.name)) continue;
    const name =
      item.kind === "main" && ["", ".", "./"].includes(item.name)
        ? ""
        : normalizeDeclaredPath(item.name);
    if (name === null)
      throw new PublishCleanError(
        `Manifest declares invalid package paths: ${JSON.stringify(item.name)}`,
      );
    let found = files.has(name);
    if (!found && item.pattern) found = published.some((file) => matchesTarget(file, name));
    else if (!found && item.kind === "main") found = mainExists(name.replace(/\/$/, ""), files);
    else if (!found && item.kind === "types")
      found = [".d.ts", ".d.mts", ".d.cts", "/index.d.ts"].some((suffix) =>
        files.has(name + suffix),
      );
    if (!found) {
      const near = nearMatch(name, published);
      missing.push(
        near === undefined
          ? JSON.stringify(item.name)
          : `${JSON.stringify(item.name)} — the archive holds ${JSON.stringify(near)}, which ` +
              `differs only in case or Unicode form, so it resolves only where the filesystem ` +
              `ignores that difference. The machine this was built on does; a consumer's may ` +
              `not. Rename it to match the packed name exactly`,
      );
    }
  }
  if (missing.length)
    throw new PublishCleanError(
      `Manifest declares files missing from packed artifact:\n${missing.join("\n")}`,
    );
}
