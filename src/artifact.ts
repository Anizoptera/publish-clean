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
import { foldName } from "./packed-names";

/**
 * Content that carries a credential. `^` means the package root.
 *
 * Split from the merely-internal patterns below because the two need OPPOSITE advice, and a
 * message giving one of them the other's is worse than a generic one: a secret needs rotating
 * whatever you do to the tarball, and telling its owner only to fix `files` reads as a repair
 * that does not exist. Nothing here is ever stripped for the author — a stripped secret has
 * still leaked, and removing it from the artifact is how it goes unrotated.
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
const SECRET_PATTERNS = [
  /(?:^|\/)\.env(?:\.|$)/i,
  /(?:^|\/)\.npmrc$/i,
  /\.(?:pem|key|p12|pfx|p8|ppk|jks|keystore)$/i,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i,
];

/**
 * Build-machine internals. Nothing to rotate — they carry no credential of their own — so the
 * only repair is to stop packing them, which is why they are judged apart from the secrets.
 */
const INTERNAL_PATTERNS = [/(?:^|\/)node_modules(?:\/|$)/i, /(?:^|\/)\.git(?:\/|$)/i];

const SUSPICIOUS_PATTERNS = [
  /(?:^|\/)(?:test|tests|__tests__|__snapshots__|coverage)(?:\/|$)/,
  /(?:^|\/)\.github(?:\/|$)/,
  /(?:^|\/)tsconfig[^/]*\.json$/,
  /(?:^|\/)(?:pnpm-lock\.yaml|bun\.lock|package-lock\.json)$/,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
];

/**
 * Judges the packed file list in two halves that must not be merged.
 *
 * A `suspicious` hit is a judgement call — hence `--allow-suspicious` — so it reports like every
 * other defect in the package being examined, and the run continues to collect the rest. It still
 * refuses to publish, through `rulesAbort`.
 *
 * A `critical` hit THROWS instead, which ends the run at the offender: nothing after this line
 * decides whether a leaked key reaches a registry, and nothing after it gets to report either. The
 * cost of that is a leaked key arriving alone, without whatever else the same package is doing
 * wrong. `Consequence` reserves `harm` for exactly this content — a secret, `node_modules`, Git
 * internals — and this throw is why nothing emits it; that member is not dead, it is this branch
 * written in the other model.
 */
export function validatePackedFiles(files: readonly string[], skipSuspicious: boolean): Finding[] {
  // One pass, and secrets win a name matching both — `node_modules/x/.env` is a leaked
  // credential first and a packed directory second, and the rotation instruction is the half
  // that expires if it arrives late.
  const secrets: string[] = [];
  const internals: string[] = [];
  for (const file of files) {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(file))) secrets.push(file);
    else if (INTERNAL_PATTERNS.some((pattern) => pattern.test(file))) internals.push(file);
  }
  const critical = [...secrets, ...internals];
  if (critical.length > 0)
    throw new PublishCleanError(
      `Critical files must not be published:\n${critical.map((file) => JSON.stringify(file)).join("\n")}\n` +
        (secrets.length > 0
          ? `Treat every credential above as compromised and rotate it now. Publishing was not ` +
            `required for that — it was packed, so it exists outside your repository already. ` +
            `This tool will not strip them for you: a stripped secret has still leaked, and an ` +
            `artifact that looks clean is how it goes unrotated.\n`
          : "") +
        `Then narrow the "files" array in your package.json so the next pack cannot reach them.`,
    );
  if (skipSuspicious) return [];

  const suspicious = files.filter((file) =>
    SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(file)),
  );
  if (suspicious.length === 0) return [];
  return [
    {
      rule: "suspicious-file",
      // Bytes and noise: none of these breaks an install or leaks anything — a leak is the
      // `critical` half above, which throws. It still stops the run, because the maintainer
      // ruled shipped waste an error outright, exactly as for `unreferenced-file`.
      consequence: "waste",
      rulesAbort: true,
      healed: false,
      where: `${suspicious.length} files`,
      message:
        `These are development files rather than anything a consumer installs, so everyone who ` +
        `installs this package downloads them forever for nothing:\n` +
        `${suspicious.map((file) => `  ${file}`).join("\n")}\n` +
        `Remove them from the "files" array in your package.json. If this package ships them on ` +
        `purpose — a test helper other packages import, a tsconfig consumers extend — overrule ` +
        `the judgement with --allow-suspicious, or "publish-clean": { "allowSuspicious": true }.`,
    },
  ];
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
