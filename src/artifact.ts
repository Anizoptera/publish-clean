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
import type { Finding } from "./finding";
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
    throw new PublishCleanError(
      `Critical files must not be published:\n${critical.map((file) => JSON.stringify(file)).join("\n")}`,
    );
  if (skipSuspicious) return;

  const suspicious = files.filter((file) =>
    SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(file)),
  );
  if (suspicious.length > 0)
    throw new PublishCleanError(
      `Suspicious files in package artifact:\n${suspicious.map((file) => JSON.stringify(file)).join("\n")}`,
    );
}

/**
 * Windows refuses these names in ANY path component, whatever the extension follows: `CON.txt`
 * names the console device, not a file, and `lib/aux/index.js` is as unopenable as `aux.js`.
 */
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
/**
 * `\` cannot reach here — the archive reader rejects it as a path alias — but it stays in the class
 * so this reads as the whole Win32 rule rather than a remainder a later reader has to reconstruct.
 * The control range is what forbids a newline inside a name.
 */
const WINDOWS_ILLEGAL = /[<>:"|?*\\\u0000-\u001f]/;
/** Win32 strips a trailing dot or space silently, landing the file under a name nothing imports. */
const WINDOWS_TRAILING = /[. ]$/;
/** ext4, APFS and NTFS all stop at 255 per component; UTF-8 bytes is the strictest reading. */
const MAX_COMPONENT_BYTES = 255;

interface Unportable {
  readonly reason: string;
  /** A Windows-only rule is waived by a package that declares it does not run there. */
  readonly windowsOnly: boolean;
}

function unportableName(name: string): Unportable | undefined {
  for (const part of name.split("/")) {
    const quoted = JSON.stringify(part);
    if (RESERVED_DEVICE.test(part))
      return { reason: `${quoted} is a reserved device name on Windows`, windowsOnly: true };
    if (WINDOWS_ILLEGAL.test(part))
      return { reason: `${quoted} holds a character Windows forbids in a name`, windowsOnly: true };
    if (WINDOWS_TRAILING.test(part))
      return {
        reason: `${quoted} ends in a dot or space, which Windows strips`,
        windowsOnly: true,
      };
    if (Buffer.byteLength(part, "utf8") > MAX_COMPONENT_BYTES)
      return { reason: `${quoted} is longer than 255 bytes`, windowsOnly: false };
  }
  return undefined;
}

/**
 * Whether a consumer on Windows can install this package at all.
 *
 * `os` is npm's own platform gate — a mismatch is EBADPLATFORM and the install never unpacks — so a
 * package that excludes Windows cannot break a Windows consumer with a name Windows refuses. Reading
 * it is what keeps this rule from refusing a publish over a platform the author already opted out
 * of.
 *
 * A list of plain names is an allowlist and a `!win32` entry is a blocklist. Doubt resolves to
 * "does not target Windows", which SUPPRESSES: this gate exists only to prevent a fabricated
 * refusal, so erring toward silence keeps it doing the one job it has.
 */
function targetsWindows(os: unknown): boolean {
  if (!Array.isArray(os)) return true;
  const names = os
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  if (names.length === 0) return true;
  if (names.includes("!win32")) return false;
  const allowed = names.filter((value) => !value.startsWith("!"));
  return allowed.length === 0 || allowed.includes("win32");
}

/**
 * Names that do not survive extraction onto a consumer's machine.
 *
 * Every other guard here asks what a file CONTAINS, or whether a file the manifest names is
 * PRESENT. These two ask whether the extracted tree can match the archive's nominal tree at all,
 * which fails differently and worse: both defects are invisible on the machine that built the
 * package, and a published version number cannot be taken back.
 *
 * Findings rather than throws, unlike the guards above. Neither poisons a later check the way a
 * missing declared file does, so the run continues and reports everything else in the same output;
 * the consequence model then stops it, because `breaks` unhealed is fatal.
 *
 * Measured over the population each rule judges before either was written. Collisions: zero across
 * 319 published tarballs, 15844 members — installed directories are the WRONG instrument for this
 * one, since two names differing only in case cannot coexist in a directory on a folding
 * filesystem, so a zero from them measures the filesystem and not the packages. Unportable names:
 * zero over those same tarballs and zero across 3490 installed packages, 187187 files. Neither zero
 * retires its rule. Frequency is not what decides here — irreversibility is — and neither rule has
 * a false-positive population to weigh against it: two names that fold together DO become one file,
 * and a name Windows refuses IS refused.
 */
export function reviewPackedNames(pkg: JsonObject, files: readonly string[]): Finding[] {
  const findings: Finding[] = [];

  const byFold = new Map<string, string[]>();
  for (const file of files) {
    const key = foldName(file);
    const group = byFold.get(key);
    if (group) group.push(file);
    else byFold.set(key, [file]);
  }
  const collisions = [...byFold.values()].filter((group) => group.length > 1);
  if (collisions.length > 0)
    findings.push({
      rule: "packed-name-collision",
      consequence: "breaks",
      healed: false,
      where: `${collisions.length} colliding names`,
      message:
        `These files become ONE file wherever the filesystem ignores letter case or Unicode ` +
        `form, which is macOS and Windows by default. One silently replaces the other, the ` +
        `install reports success, and the package is missing a file:\n` +
        collisions
          .map((group) => {
            // NFC collapses form, so an equal NFC form leaves case as the only difference and an
            // unequal one leaves form as the only remaining candidate.
            const axis =
              new Set(group.map((file) => file.normalize("NFC"))).size === 1
                ? "Unicode form"
                : "letter case";
            return `  ${group.join(" and ")} — differ only in ${axis}`;
          })
          .join("\n") +
        `\nRename one of each group so the names differ by more than case or Unicode form.`,
    });

  const windows = targetsWindows(pkg.os);
  const unportable: { file: string; defect: Unportable }[] = [];
  for (const file of files) {
    const defect = unportableName(file);
    if (defect !== undefined && (windows || !defect.windowsOnly)) unportable.push({ file, defect });
  }
  if (unportable.length > 0)
    findings.push({
      rule: "packed-name-unportable",
      consequence: "breaks",
      healed: false,
      where: `${unportable.length} files`,
      message:
        `These packed names cannot be created on a consumer's filesystem. Installing either ` +
        `fails outright or writes the file under a different name, and nothing imports the name ` +
        `it lands under:\n` +
        unportable.map((item) => `  ${item.file} — ${item.defect.reason}`).join("\n") +
        `\nRename them so every path component is legal everywhere.` +
        (unportable.every((item) => item.defect.windowsOnly)
          ? ` If this package genuinely does not run on Windows, say so instead and npm will ` +
            `refuse the install there rather than break it: "os": ["!win32"].`
          : ``),
    });

  return findings;
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
 * How two names are compared when asking whether a filesystem could confuse them.
 *
 * The single definition of "the same name" for every rule that asks: a manifest target that
 * misses, an import that misses, and two packed files that collide. They report different defects,
 * but a disagreement here would let one call a pair identical while another calls it absent, which
 * reads as a contradiction inside one report.
 *
 * `toLowerCase` is not any real filesystem's fold — NTFS uses an uppercase table and APFS full
 * Unicode case folding — but it is the same approximation everywhere in this tool, and agreement
 * between the rules matters more here than matching one filesystem exactly.
 */
export function foldName(value: string): string {
  return value.normalize("NFC").toLowerCase();
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
