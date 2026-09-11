/**
 * What the shipped files themselves say, and which of them nothing reaches.
 *
 * Every check here needs the tarball's BYTES, not only its file list, which is why they live
 * together and why none of them exists in a linter that reads a source directory: the archive is
 * the only place where what a branch promises and what the package actually ships can be compared.
 *
 * Ambient inputs arrive as parameters — no process, filesystem or argv here. `cli.ts` owns the
 * effects.
 */
import { Script } from "node:vm";

import { collectDeclaredPaths, normalizeDeclaredPath } from "./artifact";
import { rowsOf } from "./conditions";
import type { Finding } from "./finding";
import { isObject } from "./json";
import type { JsonObject } from "./json";
import { lexicalZones, zoneAt } from "./lexical";
import { foldName } from "./packed-names";

const DECLARATION = /\.d\.[cm]?ts$/;
const SCRIPT = /\.[cm]?[jt]sx?$/;

/**
 * Files that are unreachable by nature and still earn their bytes. Documentation is read by a
 * human, declarations by a type checker, a source map by a debugger, a native binary by a loader
 * that builds its path at run time — none of them is imported by anything, and a reachability
 * rule that does not know this fires on essentially every package ever published.
 *
 * Measured across 655 packages: flagging any file unreachable through `exports` fires on 97.1% of
 * them. That figure is an instrument error, not a threshold to tune — "useless" means changes no
 * behaviour AND tells nobody anything, and reachability tests a proxy for the first clause while
 * saying nothing at all about the second.
 */
const UNREACHABLE_BY_NATURE = [
  // A legal or documentation file, anywhere in the tree and under any casing. The `\.` branch
  // catches the `bundle.js.LICENSE` form that webpack and terser emit beside a bundle.
  /(?:^|\/|\.)(?:readme|licen[cs]e|copying|notice|changelog|history|authors|contributors)/i,
  // A nested `package.json` is READ BY NODE, not imported: `dist/cjs/package.json` holding
  // `{"type":"commonjs"}` is what makes that directory load as CommonJS at all. Deleting it on
  // this rule's advice would break the package.
  /(?:^|\/)package\.json$/,
  /\.(?:md|markdown|txt|map|node|wasm|flow)$/i,
  // Assets a browser or a bundler consumes. The closure models the JavaScript import graph and
  // has no standing over a stylesheet a consumer links by path or a font a CSS rule names.
  /\.(?:css|s[ac]ss|less|html?|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|otf)$/i,
  /^(?:prebuilds|native|build|man|bin)\//i,
  DECLARATION,
];

/**
 * Specifiers a file mentions, deliberately over-matched: this pattern also fires inside comments
 * and string literals.
 *
 * That direction is the safe one and it is the whole reason a pattern is acceptable here where a
 * parser would normally be required. The finding is "NOTHING references this file", so a spurious
 * match can only SUPPRESS a report, never invent one. The usual objection to matching syntax with
 * a pattern assumes a false negative is the safe direction; here it is the false POSITIVE that
 * would cost an author a failed publish for a file that is genuinely used.
 *
 * A parser would buy precision this check must not spend, because precision here means reporting
 * more files as dead.
 */
const SPECIFIER =
  /(?:from\s*|require\s*\(\s*|import\s*\(?\s*|URL\s*\(\s*|sourceMappingURL=)['"`]?(\.[^'"`\s)]+)/g;

/** Targets written under a condition key, for the checks that ask what one consumer receives. */
function targetsUnder(node: unknown, condition: string, inside: boolean, out: string[]): void {
  if (typeof node === "string") {
    if (inside) out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) targetsUnder(item, condition, inside, out);
    return;
  }
  if (!isObject(node)) return;
  for (const [key, value] of Object.entries(node))
    targetsUnder(
      value,
      condition,
      inside || key === condition || key.startsWith(`${condition}@`),
      out,
    );
}

/**
 * The two positions that load a module: the statement form, and the call form.
 *
 * A template literal is legal only in the CALL forms — `import x from \`y\`` is a syntax error —
 * and accepting a backtick after `from` matched English prose in the corpus ("filters out internal
 * stacks from `vitest/dist`").
 */
function selfSpecifiers(name: string): readonly RegExp[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = `(${escaped}(?:/[^'"\`]*)?)`;
  return [
    new RegExp(`(?:from|import)\\s*(['"])${body}\\1`, "g"),
    new RegExp(`(?:require|import)\\s*\\(\\s*(['"\`])${body}\\1`, "g"),
  ];
}

/**
 * Whether the package's own `exports` exposes this subpath at all.
 *
 * A key mapping to `null` under every condition blocks the subpath deliberately, so key presence
 * is not the question — `rowsOf` answers the real one. Which consumer gets which file is a
 * different check; this one only asks whether anybody can reach the subpath.
 */
function exposes(exports: unknown, subpath: string): boolean {
  if (typeof exports === "string" || Array.isArray(exports)) return subpath === ".";
  if (!isObject(exports)) return false;
  const keys = Object.keys(exports);
  if (!keys.some((key) => key.startsWith("."))) return subpath === ".";
  for (const key of keys) {
    const star = key.indexOf("*");
    const matched =
      star === -1
        ? key === subpath
        : subpath.length >= key.length - 1 &&
          subpath.startsWith(key.slice(0, star)) &&
          subpath.endsWith(key.slice(star + 1));
    if (!matched) continue;
    const rows = rowsOf(exports[key]);
    // A fallback array is opaque to the row algebra — the resolvers disagree about it — but every
    // resolver that accepts one resolves the subpath, so it is exposed. `yargs` and
    // `generator-function` both expose their root that way, and calling that unexposed would
    // refuse their publish over a map that works.
    return (
      rows === null ||
      rows.some((row) => row.target.kind === "file" || row.target.kind === "opaque")
    );
  }
  return false;
}

/**
 * Reports a package importing ITSELF by name through a subpath its own `exports` does not expose.
 *
 * Self-reference resolves through `exports` like any consumer's import would, so shipping the file
 * is not enough — and the author never sees it, because inside their own repository the same
 * import resolves through the source tree instead. Measured across 662 published packages with
 * `exports`: 2 carry one, and both are real. `@eslint-community/regexpp` ships an `index.d.ts`
 * importing `@eslint-community/regexpp/ast` while exporting only `.`; `highlight.js` references
 * `highlight.js/private` from both its declarations and its JSDoc types, exporting neither.
 *
 * Why `breaks` rather than waste, measured on TypeScript 7.0.2 with a control subpath that is
 * exported: under `skipLibCheck: false` the consumer gets `TS2307` inside a file they cannot edit,
 * and under `skipLibCheck: true` — the common default — the type silently degrades to an
 * error-suppressed `any`. A build that fails and a build that quietly types itself wrong are both
 * this class. A runtime `require` of an unexposed subpath throws outright, though the corpus held
 * no instance of that.
 */
export function reviewSelfReferences(
  pkg: JsonObject,
  files: ReadonlyMap<string, Buffer>,
): Finding[] {
  const name = pkg.name;
  // Self-reference by name is only resolvable when `exports` exists, so without it there is no
  // defect to find: every shipped path is importable by its relative path anyway.
  if (typeof name !== "string" || pkg.exports === undefined) return [];

  const findings: Finding[] = [];
  const patterns = selfSpecifiers(name);
  const seen = new Set<string>();
  for (const [file, body] of files) {
    if (!SCRIPT.test(file)) continue;
    const source = body.toString("utf8");
    if (!source.includes(name)) continue;
    const zones = lexicalZones(source);
    // A scan that lost its place reports nothing from this file: see `lexicalZones`.
    if (zones === null) continue;
    for (const pattern of patterns)
      for (const match of source.matchAll(pattern)) {
        const zone = zoneAt(zones, match.index);

        // A specifier inside a string or template literal is text this file GENERATES for
        // somebody else's project, not an import this file performs — measured in `@opentui/core`,
        // which writes an import statement into a string.
        if (zone === "text") continue;

        // Comments are SCANNED, not stripped: `{import("pkg/sub").Type}` in a JSDoc block is a
        // real type import a checker resolves, and `highlight.js` is caught by exactly those.
        // What is skipped is prose — a documentation example of an import, measured as the whole
        // false-positive population (`rolldown` and `nanoid` both advertise a subpath they
        // removed). `import(...)` is the ONLY form a checker reads inside a comment: an import
        // statement is not legal there, and a commented-out `require(...)` is dead code nothing
        // resolves, which is how `yargs` documents its own usage.
        if (zone === "comment" && !/^import\s*\(/.test(match[0])) continue;

        const start = source.lastIndexOf("\n", match.index) + 1;
        const end = source.indexOf("\n", match.index);
        const line = source.slice(start, end === -1 ? undefined : end).trim();
        const specifier = match[2] ?? "";
        const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
        if (exposes(pkg.exports, subpath) || seen.has(specifier)) continue;
        seen.add(specifier);
        findings.push({
          rule: "self-import-not-exported",
          consequence: "breaks",
          healed: false,
          where: file,
          message:
            `${JSON.stringify(specifier)} is this package importing itself, and "exports" does ` +
            `not expose ${JSON.stringify(subpath)}, so it resolves to nothing for every consumer ` +
            `— a type checker reports TS2307 in a file they cannot edit, or silently types it as ` +
            `any. Inside this repository the same import resolves through the source tree, which ` +
            `is why it looks fine here. Add the subpath:\n` +
            `  "exports": { ${JSON.stringify(subpath)}: "./<the file it means>" }\n` +
            `or rewrite the import as a relative path. Found at: ${line.slice(0, 120)}`,
        });
      }
  }
  return findings;
}

function entry(files: ReadonlyMap<string, Buffer>, target: string): Buffer | undefined {
  const name = normalizeDeclaredPath(target);
  return name === null ? undefined : files.get(name);
}

/**
 * Reports what the files an `exports` branch names turn out to be.
 *
 * These are the defects a source-directory linter cannot see, because each is a disagreement
 * between what the manifest promises and what the archive actually carries.
 */
export function reviewShippedFiles(pkg: JsonObject, files: ReadonlyMap<string, Buffer>): Finding[] {
  const findings: Finding[] = [];
  const maps = [pkg.exports, pkg.imports];

  // A `types` branch that does not name a declaration file hands the checker something else to
  // read as declarations — usually the JavaScript beside it, which types the whole package `any`.
  const typeTargets: string[] = [];
  for (const map of maps) targetsUnder(map, "types", false, typeTargets);
  for (const target of new Set(typeTargets))
    if (!DECLARATION.test(target) && SCRIPT.test(target))
      findings.push({
        rule: "types-branch-not-declarations",
        consequence: "breaks",
        healed: false,
        where: `exports "types" -> ${target}`,
        message:
          `A "types" condition must resolve to a declaration file (.d.ts, .d.mts or .d.cts); ` +
          `this one resolves to ${JSON.stringify(target)}. A type checker takes this branch and ` +
          `reads that file as the package's declarations, so every consumer sees the wrong API ` +
          `or none. Point the branch at the declaration file built beside it.`,
      });

  // A `require` branch must name a file `require()` can actually load.
  const requireTargets: string[] = [];
  for (const map of maps) targetsUnder(map, "require", false, requireTargets);
  for (const target of new Set(requireTargets)) {
    if (DECLARATION.test(target) || !SCRIPT.test(target)) continue;
    const body = entry(files, target);
    if (!body || isCommonJs(body.toString("utf8"))) continue;
    findings.push({
      rule: "require-branch-is-esm",
      consequence: "breaks",
      healed: false,
      where: `exports "require" -> ${target}`,
      message:
        `A "require" condition resolves to ${JSON.stringify(target)}, which uses ES module ` +
        `syntax. Node can require an ES module only from ^20.19.0 || >=22.12.0, a consumer can ` +
        `still refuse with --no-experimental-require-module, and top-level await fails on every ` +
        `version with ERR_REQUIRE_ASYNC_MODULE. Point "require" at a CommonJS build, or add a ` +
        `"module-sync" branch — that condition exists so require() and import can load one ES ` +
        `module.`,
    });
  }

  // A shebang ending in CR is invisible in an editor and fatal on every POSIX system: the kernel
  // passes `node\r` to execve as the interpreter name.
  //
  // The neighbouring check nobody should build: a `bin` entry shipped WITHOUT the executable bit.
  // Installers restore it, because tarballs authored on Windows routinely lack it — measured by
  // installing a hand-built archive whose `bin` member is 0644, which bun and pnpm both unpack to
  // 0755 and run. npm cannot fail to: `bin-links` 6.0.2 `lib/fix-bin.js` is an unconditional
  // `chmod(file, 0o777 & ~umask)` called from both the symlink and the Windows-shim path, so it
  // never consults the archive's mode. (yarn unmeasured.) A check would fire on a package that works.
  for (const [name, body] of files) {
    if (!body.subarray(0, 2).equals(Buffer.from("#!"))) continue;
    const firstLine = body.subarray(0, body.indexOf(0x0a) + 1 || body.length);
    if (!firstLine.includes(0x0d)) continue;
    findings.push({
      rule: "shebang-carriage-return",
      consequence: "breaks",
      healed: false,
      where: name,
      message:
        `The shebang line ends with a carriage return, so running this file fails with ` +
        `"env: node\\r: No such file or directory" on Linux and macOS. Nothing here rewrites it ` +
        `— this tool alters the manifest and no other file's contents — so fix the line endings ` +
        `at the source: add a .gitattributes entry marking it "text eol=lf", or set your ` +
        `bundler to emit LF.`,
    });
  }

  return findings;
}

/**
 * True when `require()` can load this source.
 *
 * `new Script(source)` IS Node's CommonJS parser, so this asks the question with the instrument
 * that decides it rather than with a pattern that approximates it: `import`, `export`,
 * `import.meta` and top-level await all throw, and every CommonJS form compiles. No vendored
 * parser, no subprocess, no dependency — which matters for a CLI that ships none.
 */
function isCommonJs(source: string): boolean {
  try {
    new Script(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * Files nothing in the package reaches, ranked by the bytes they cost.
 *
 * Reachability is EVIDENCE that a file may be useless, never the verdict. The closure below
 * starts from every path the manifest declares and follows relative specifiers out of each file
 * it reaches, so what remains is genuinely referenced by nothing — but a file can still be used
 * in ways no import graph records: a child process spawned by path, a native loader reading
 * `prebuilds/`, a data directory read with `fs`. `UNREACHABLE_BY_NATURE` covers every category
 * measured across 655 real packages; `allowUnreferenced` covers the rest, and the message names
 * the exact line to paste, so switching this on costs an affected author one edit rather than an
 * investigation.
 *
 * Size-ranked, because a name-based rule misses precisely the biggest finds: the largest real
 * cases measured sat in `ai-docs/` (17.7MB) and `artifacts/` (17.8MB), directories no name list
 * anticipates, while restricting to `test`/`docs`/`examples` names caught 0.1% of wasted bytes.
 */
export function reviewUnreferencedFiles(
  pkg: JsonObject,
  files: ReadonlyMap<string, Buffer>,
  allowUnreferenced: readonly string[],
): Finding[] {
  // `exports` is what makes "nothing can reach this" a true statement. Without it every shipped
  // file is a public entry point: a consumer may `require("pkg/lib/deflate")` and many do, so an
  // unreferenced file is not dead, it is undocumented API somebody may already depend on.
  // Measured: gating on this field is the difference between firing on 62% of installed packages
  // and firing on the ones where the claim actually holds.
  if (pkg.exports === undefined) return [];

  const reached = new Set<string>();
  const queue: string[] = [];
  const mismatches: string[] = [];
  // Built on the first unresolved relative specifier and never for a package that has none, which
  // is nearly all of them: measured across 300 published packages and 21451 relative specifiers,
  // this fires zero times. The happy path must not pay for it.
  const EMPTY = Buffer.alloc(0);
  let foldedNames: Map<string, string> | undefined;
  let foldedFiles: Map<string, Buffer> | undefined;
  // Zones for the file currently being drained, computed only if a mismatch is about to be
  // reported — which measured zero times across 300 packages, so the closure never pays for it.
  let zoned: { file: string; zones: null | Uint8Array } | undefined;
  const inCode = (source: string, file: string, at: number): boolean => {
    if (zoned?.file !== file) zoned = { file, zones: lexicalZones(source) };
    // A scanner with no grammar can desync; it says so, and from an untrusted position this scan
    // must yield nothing rather than refuse a sound package.
    return zoned.zones !== null && zoneAt(zoned.zones, at) === "code";
  };

  const visit = (declared: string, from: string, source?: string, at?: number): void => {
    // Join against the referring file BEFORE normalising: normalisation strips the leading `./`,
    // so testing for relativity afterwards answers about the wrong string and every sibling
    // import resolves to the package root instead. That single ordering mistake left the closure
    // reaching nothing but its own seeds.
    const raw = declared.replace(/[?#].*$/, "");
    const relative = raw.startsWith("./") || raw.startsWith("../");
    const resolved = normalizeDeclaredPath(relative ? joinFrom(from, raw) : raw);
    if (resolved === null) return;
    const targets = expand(resolved, files);
    // A relative specifier written by a SHIPPED file must resolve inside the package. When it does
    // not, but the same name resolves once case and Unicode form are folded, the import cannot
    // resolve on a filesystem that honours the difference: the package runs for its author and
    // fails on a consumer's machine. Reporting it is not optional politeness — without it the
    // target is simply never reached, and the dead-file rule below then tells the author to DELETE
    // a file their own code imports.
    //
    // Only specifiers from source files. A manifest target that misses is already reported by
    // `assertDeclaredFiles`, and the script-token seeds are over-matched on purpose, so a miss
    // there carries no information. Patterns are excluded because `expand` answers them by
    // scanning, where an empty result means no match rather than a broken name.
    //
    // And ONLY from a code position. `SPECIFIER` over-matches deliberately, which is safe for the
    // dead-file rule because a spurious match can only suppress a report — this finding INVERTS
    // that direction, so the same spurious match would invent one and abort a correct publish. A
    // comment reading `see ./Utils.js` beside a shipped `utils.js` is the whole false-positive
    // population, and `lexical.ts` is what tells the two apart.
    if (
      targets.length === 0 &&
      relative &&
      from !== "" &&
      !resolved.includes("*") &&
      source !== undefined &&
      at !== undefined &&
      inCode(source, from, at)
    ) {
      foldedNames ??= new Map([...files.keys()].map((file) => [foldName(file), file]));
      // Folding the LOOKUP rather than re-implementing it: `expand` owns the suffix list and the
      // `.js`→`.ts` convention, so a second matcher here would drift from the real one.
      foldedFiles ??= new Map([...foldedNames.keys()].map((file) => [file, EMPTY]));
      const near = expand(foldName(resolved), foldedFiles)
        .map((candidate) => foldedNames?.get(candidate))
        .find((candidate) => candidate !== undefined);
      if (near !== undefined) {
        mismatches.push(`  ${from} imports ${JSON.stringify(declared)}, shipped as ${near}`);
        // Reached, because it IS referenced — wrongly. Leaving it unreached would report the same
        // file twice, once as broken and once as dead weight, with opposite instructions.
        if (!reached.has(near)) {
          reached.add(near);
          queue.push(near);
        }
      }
      // The `near === undefined` case — a relative import resolving to NOTHING — is deliberately
      // not reported. Measured: it fires on 9.1% of packages with `exports` (135 of 1482), and
      // narrowing it to exclude interpolated specifiers, `.node` bindings and declaration sources
      // still leaves 6.5%, all of them packages that work. The near match is not a narrowing, it
      // is the CORROBORATION that makes this rule sound: a folded name hitting a real shipped file
      // is independent evidence that the specifier is a static path to a file that exists, which
      // "resolves to nothing" never establishes. `docs/exports.md` carries the specimens.
    }
    for (const candidate of targets)
      if (!reached.has(candidate)) {
        reached.add(candidate);
        queue.push(candidate);
      }
  };

  const seeds: string[] = [];
  // `collectDeclaredPaths` already knows which manifest fields hold paths and which of their
  // strings are paths at all, so the seed set cannot drift from the one `assertDeclaredFiles`
  // validates. `bin` and `main` are commonly written bare (`dist/cli.js`, not `./dist/cli.js`) —
  // treating those as external reported every such entry as dead and cost a 3.4x error in the
  // measurement that produced the numbers above.
  for (const field of ["main", "module", "types", "typings", "bin", "exports", "imports", "man"])
    collectDeclaredPaths(pkg[field], seeds, "every-string");
  collectDeclaredPaths(
    pkg.browser,
    seeds,
    typeof pkg.browser === "string" ? "every-string" : "relative-only",
  );
  for (const seed of seeds) visit(seed, "");

  // A lifecycle script names its helper in a shell command — `"postinstall": "node install.cjs"` —
  // and `scripts` survives cleaning precisely when a consumer hook exists, so that file runs on
  // every install while no import anywhere mentions it. Every script is read, not only the
  // lifecycle ones, because hooks delegate: `postinstall: "npm run setup"` names the file one hop
  // away. Splitting on shell punctuation over-matches, which is the harmless direction here: a
  // token only becomes a seed if it names a file the package actually ships.
  if (isObject(pkg.scripts))
    for (const command of Object.values(pkg.scripts))
      if (typeof command === "string")
        for (const token of command.split(/[\s'"=;&|()<>]+/)) visit(token, "");

  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined) continue;
    const body = files.get(name);
    // An executable is usually extensionless — TypeScript's `bin/tsc` is two lines whose second
    // is `require('../lib/tsc.js')` — so a suffix test alone stops the closure at the shim and
    // calls the entire compiler unreferenced. The shebang identifies the rest.
    if (body === undefined || !(SCRIPT.test(name) || body.subarray(0, 2).toString() === "#!"))
      continue;
    const source = body.toString("utf8");
    for (const match of source.matchAll(SPECIFIER))
      if (match[1] !== undefined) visit(match[1], name, source, match.index);
  }

  const findings: Finding[] = [];
  if (mismatches.length > 0)
    findings.push({
      rule: "import-case-mismatch",
      // Breaks a consumer, so it aborts: the import fails at run time on their machine and a
      // published version number cannot be taken back.
      consequence: "breaks",
      healed: false,
      where: `${mismatches.length} imports`,
      message:
        `These imports resolve only because the filesystem this was built on ignores letter ` +
        `case or Unicode form. Where one does not, the import fails and the package is broken ` +
        `for that consumer:\n${mismatches.join("\n")}\n` +
        `Rename the import or the file so the two match byte for byte.`,
    });

  const orphans = [...files]
    .filter(([name]) => !reached.has(name))
    .filter(([name]) => !UNREACHABLE_BY_NATURE.some((pattern) => pattern.test(name)))
    .filter(
      ([name]) =>
        !allowUnreferenced.some((allowed) => name === allowed || name.startsWith(allowed)),
    )
    .sort((left, right) => right[1].length - left[1].length);
  if (orphans.length === 0) return findings;

  const total = orphans.reduce((sum, [, body]) => sum + body.length, 0);
  const listed = orphans.map(([name, body]) => `  ${name} (${Math.ceil(body.length / 1024)} KB)`);
  findings.push({
    rule: "unreferenced-file",
    consequence: "waste",
    // Ruled an error outright by the maintainer, despite costing only bytes: every consumer
    // downloads these forever. Carried as a flag rather than a branch on the rule id so the one
    // divergence from the consequence model stays visible in the findings table.
    rulesAbort: true,
    healed: false,
    where: `${orphans.length} files, ${Math.ceil(total / 1024)} KB`,
    message:
      `Nothing in this package reaches these files — no manifest field names them and no ` +
      `shipped file imports them — so every consumer downloads them forever for nothing:\n` +
      `${listed.join("\n")}\n` +
      `Remove them from the "files" array in your package.json. If one is genuinely used in a ` +
      `way no import records — spawned as a child process, loaded by a native addon, read at ` +
      `run time — declare it instead:\n` +
      `  "publish-clean": { "allowUnreferenced": [${orphans.map(([name]) => JSON.stringify(name)).join(", ")}] }`,
  });
  return findings;
}

/** Resolve a relative specifier against the file that wrote it. */
function joinFrom(from: string, specifier: string): string {
  const base = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
  return `${base}${specifier}`;
}

/**
 * The names one specifier can select: an extensionless import, a directory index, a pattern, and
 * the source map a file points at all name real files through a written form that is not one.
 */
function expand(name: string, files: ReadonlyMap<string, Buffer>): string[] {
  if (name.includes("*")) {
    const parts = name.split("*");
    return [...files.keys()].filter(
      (file) =>
        file.length >= name.length - 1 &&
        file.startsWith(parts[0] ?? "") &&
        file.endsWith(parts.at(-1) ?? ""),
    );
  }
  if (files.has(name)) return [name];
  // A TypeScript source imports its sibling as `./schemas.js` even though the file shipped is
  // `schemas.ts`; that is the convention for ESM TypeScript, not a mistake. Without this the
  // closure stops at the first source file and reports a package's whole `src` tree as dead —
  // measured on zod, where it mislabelled 4 MB, most of it genuinely reachable.
  const swapped = name.replace(/\.([cm]?)js$/, ".$1ts");
  // The same convention one file-kind further: a DECLARATION imports its sibling as `./types.js`
  // and what ships is `types.d.ts`. Without this, a wrong-CASE import between two declaration
  // files resolves to nothing, no near match is found, and the case-mismatch rule — which exists
  // precisely to catch that — stays silent on the commonest shape in a typed package.
  const declared = name.replace(/\.([cm]?)js$/, ".d.$1ts");
  const bases =
    swapped === name ? [name] : [name, swapped, swapped.replace(/ts$/, "tsx"), declared];
  return bases
    .flatMap((base) =>
      // `.d.ts` covers the EXTENSIONLESS form (`from "./types"`), which belongs to the classic
      // resolution style; that style predates the `.mts`/`.cts` family, so there is no
      // extensionless `.d.mts` to look for. Their explicit-extension forms ride on `declared`.
      ["", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".json", ".node", ".d.ts"]
        .flatMap((suffix) => [base + suffix, `${base}/index${suffix}`])
        .concat(base),
    )
    .filter((candidate) => files.has(candidate));
}
