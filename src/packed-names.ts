/**
 * Whether the archive's own NAMES survive extraction onto a consumer's machine.
 *
 * Separate from the rules that compare the manifest against the archive: these read nothing but the
 * entry paths, and the defects they find are invisible on the machine that built the package —
 * a filesystem that folds letter case, or one that accepts a name another refuses. A published
 * version cannot be taken back, so both abort.
 *
 * Ambient inputs arrive as parameters and never by reaching for them — no process, filesystem or
 * argv here, which is also what lets every rule be judged from a constructed file list.
 */
import type { Finding } from "./finding";
import { countOf } from "./finding";
import type { JsonObject } from "./json";

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
/**
 * ext4, APFS and NTFS all stop at 255 per component, but they COUNT differently: NTFS counts
 * UTF-16 units and the others count bytes. That gap is what makes this reachable rather than
 * theoretical — a name of non-ASCII characters can sit well inside Windows' limit and exceed the
 * byte limit everywhere else, so a Windows author can create and pack a file that no Linux or
 * macOS consumer can unpack. Bytes is the strict reading, and the only one safe for all three.
 */
const MAX_COMPONENT_BYTES = 255;

interface Unportable {
  readonly reason: string;
  /** Reported only to a package that targets Windows, and so the only kind the advice can address. */
  readonly windowsOnly: boolean;
}

/**
 * The first reason this name cannot be created on a filesystem the package targets.
 *
 * `windows` is consulted HERE rather than by the caller, and that is the whole design. One name can
 * hold several defects at once — `aux.` followed by 300 bytes is both a reserved device name and an
 * over-long component — so a scan that returns whichever it meets first and lets the caller waive on
 * THAT defect's platform hands the `os` waiver authority over a reason it does not own, and the
 * package ships a name no Linux or macOS consumer can unpack. Skipping the waived checks instead
 * makes the whole class unreachable: nothing waivable is ever returned to be waived.
 *
 * Byte length goes first for the same reason. When both apply, the reason that binds EVERYWHERE is
 * the true one, and it also picks the honest advice: suggesting `"os": ["!win32"]` over a name ext4
 * refuses anyway sends the author to do the one thing that cannot help.
 */
function unportableName(name: string, windows: boolean): Unportable | undefined {
  for (const part of name.split("/")) {
    const quoted = JSON.stringify(part);
    if (Buffer.byteLength(part, "utf8") > MAX_COMPONENT_BYTES)
      return { reason: `${quoted} is longer than 255 bytes`, windowsOnly: false };
    if (!windows) continue;
    if (RESERVED_DEVICE.test(part))
      return { reason: `${quoted} is a reserved device name on Windows`, windowsOnly: true };
    if (WINDOWS_ILLEGAL.test(part))
      return { reason: `${quoted} holds a character Windows forbids in a name`, windowsOnly: true };
    if (WINDOWS_TRAILING.test(part))
      return {
        reason: `${quoted} ends in a dot or space, which Windows strips`,
        windowsOnly: true,
      };
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

  // Files grouped by folded name, and beside them every DIRECTORY the archive implies. A path
  // carried as a file by one entry and as a directory by another survives only while the two
  // spellings stay distinct: fold them together and the installer writes one, then cannot create
  // the other, so the install fails outright rather than quietly losing a file. Only a
  // case-sensitive filesystem can author that pair, which is why its author never sees it. Two
  // DIRECTORIES differing in case are not a defect — both spellings lead to one directory and
  // every file inside it still arrives.
  const byFold = new Map<string, string[]>();
  const directories = new Map<string, string>();
  for (const file of files) {
    const key = foldName(file);
    const group = byFold.get(key);
    if (group) group.push(file);
    else byFold.set(key, [file]);
    for (let cut = file.indexOf("/"); cut !== -1; cut = file.indexOf("/", cut + 1))
      directories.set(foldName(file.slice(0, cut)), file.slice(0, cut));
  }

  const collisions = [...byFold.entries()].flatMap(([folded, group]) => {
    const directory = directories.get(folded);
    const clashing = directory === undefined ? group : [...group, `${directory}/`];
    return clashing.length > 1 ? [clashing] : [];
  });
  if (collisions.length > 0)
    findings.push({
      rule: "packed-name-collision",
      consequence: "breaks",
      healed: false,
      where: countOf(collisions.length, "colliding name"),
      message:
        `These entries collapse onto one path wherever the filesystem ignores letter case or ` +
        `Unicode form, which is macOS and Windows by default. Two files means one silently ` +
        `replaces the other and the install still reports success; a file against a directory ` +
        `means the install fails outright:\n` +
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
    const defect = unportableName(file, windows);
    if (defect !== undefined) unportable.push({ file, defect });
  }
  if (unportable.length > 0)
    findings.push({
      rule: "packed-name-unportable",
      consequence: "breaks",
      healed: false,
      where: countOf(unportable.length, "file"),
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
