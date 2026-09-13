import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Every name the shipped documents use must be a name `src/` actually defines.
 *
 * README.md must name every rule id, CLI flag and config key this tool has, and CHANGELOG.md's
 * pending section must promise no flag it does not.
 *
 * README.md ships in the package. It is the reference an agent or maintainer reads straight out of
 * `node_modules`, with no repository and no network, so anything missing from it is missing at the
 * moment someone is stuck. A finding prints as `publish-clean [severity] <rule-id> at <where>`
 * (`src/finding.ts`), which makes the rule id the thing a reader arrives holding; a flag and a
 * config key are what they arrive looking for.
 *
 * This exists because all three rot silently and in both directions: adding a rule, flag or key
 * breaks nothing, and RENAMING one leaves the dead name sitting in the README reading exactly like
 * documentation. No test catches either — tests assert on the names they were written with.
 *
 * Substring match against the whole file, not a table lookup: each name belongs in the prose that
 * already explains its subject. A dedicated table would be `src/` copied out by hand, which is the
 * failure this check exists to prevent rather than a way to satisfy it.
 */
const ROOT = path.join(import.meta.dirname, "..");

/** Text between a declaration's opening line and its terminator, so a scan cannot drift into unrelated code. */
function block(file: string, opens: string, closes: string): string {
  const source = readFileSync(path.join(ROOT, "src", file), "utf8");
  const from = source.indexOf(opens);
  const to = source.indexOf(closes, from);
  if (from === -1 || to === -1)
    throw new Error(
      `src/${file} no longer contains \`${opens}\` … \`${closes}\`. That declaration is this ` +
        `check's whole population, so it is now measuring nothing. Repoint the scan in ` +
        `${path.relative(ROOT, import.meta.filename)}.`,
    );
  return source.slice(from + opens.length, to);
}

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].flatMap(([, name]) => (name === undefined ? [] : [name]));
}

function ruleIds(): string[] {
  const ids: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, "src"))) {
    if (!entry.endsWith(".ts")) continue;
    const source = readFileSync(path.join(ROOT, "src", entry), "utf8");
    ids.push(...matches(source, /rule: "([a-z-]+)"/g));
  }
  return ids;
}

/** Named separately because the changelog rule below judges the same population. */
const cliFlags = matches(
  block("options.ts", "const CLI_FLAGS = {", "} as const;"),
  /^\s*"?([a-z][a-z-]*)"?:\s*\{/gm,
);

/**
 * Each surface, with the form the README must carry it in. A flag is searched WITH its dashes:
 * `strict` alone appears in ordinary prose, so the bare name would pass on a README that never
 * documents the flag.
 */
const SURFACES = [
  { what: "rule id", names: ruleIds(), form: (name: string) => name },
  { what: "CLI flag", names: cliFlags, form: (name: string) => `--${name}` },
  {
    what: "config key",
    names: matches(block("config.ts", "const CONFIG_KEYS = new Set([", "]);"), /"([a-zA-Z]+)"/g),
    form: (name: string) => name,
  },
];

const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
const missing: string[] = [];

for (const { what, names, form } of SURFACES) {
  // A scan that matches nothing reads exactly like a clean result: it would report a README it
  // never actually checked. Only an empty population can produce that, so refuse it by name.
  if (names.length === 0)
    throw new Error(
      `Found no ${what}s in src/. The spelling this check scans for has changed, so it is ` +
        `measuring nothing. Fix the scan in ${path.relative(ROOT, import.meta.filename)}.`,
    );
  for (const name of [...new Set(names)].sort())
    if (!readme.includes(form(name))) missing.push(`  ${form(name)}  (${what})`);
}

if (missing.length > 0)
  throw new Error(
    `README.md documents none of these, and it ships as the offline reference:\n` +
      `${missing.join("\n")}\n` +
      `Add each to the prose that already covers its subject — tag a rule's bullet [\`rule-id\`]. ` +
      `Do not start a separate table: that is src/ copied out, and it rots.`,
  );

/**
 * `## Unreleased` only. Released sections describe the tool as it stood when they shipped, so a
 * flag dropped later makes them history rather than errors. An absent section is the normal state
 * right after a release consumed it.
 */
function unreleasedSection(changelog: string): string {
  const from = changelog.indexOf("\n## Unreleased");
  if (from === -1) return "";
  const to = changelog.indexOf("\n## ", from + 1);
  return to === -1 ? changelog.slice(from) : changelog.slice(from, to);
}

/**
 * The pending release notes must not promise a flag this tool does not have.
 *
 * That section is published verbatim as the GitHub Release body, so a name that died mid-cycle
 * reaches consumers as instructions. It runs the opposite direction to the README rule above and
 * catches what that one cannot: the forward check falls silent as soon as the NEW name appears
 * somewhere, leaving the dead name in place, reading exactly like documentation.
 *
 * Every flag is compared against CLI_FLAGS with no allowance for foreign ones, which holds only
 * because this section never mentions any: measured 2026-09-13, the README names `--provenance`,
 * `--access`, `--tag` and `--frozen-lockfile`, all owned by npm or a package manager, and the
 * changelog names none of them. Should that change, widen the population from a declaration in
 * `src/`, never by listing names here — a hand-kept list of someone else's flags is the rot this
 * file exists to stop.
 */
const legalFlags = new Set(cliFlags.map((name) => `--${name}`));
const invented = [
  ...new Set(
    matches(
      unreleasedSection(readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8")),
      /(--[a-z][a-z-]+)/g,
    ),
  ),
]
  .filter((flag) => !legalFlags.has(flag))
  .sort();

if (invented.length > 0)
  throw new Error(
    `CHANGELOG.md "## Unreleased" promises flags this tool does not have:\n` +
      `${invented.map((flag) => `  ${flag}`).join("\n")}\n` +
      `That section ships as the GitHub Release body. Use the current name, or drop the claim.`,
  );
