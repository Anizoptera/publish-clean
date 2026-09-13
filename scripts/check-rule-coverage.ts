import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Every rule id a finding can carry must appear in README.md.
 *
 * A finding prints as `publish-clean [severity] <rule-id> at <where>` (`src/finding.ts`), so the id
 * is what a user or an agent has in hand when something refuses their publish — and README.md is
 * the reference they read, straight out of `node_modules`, with no repository and no network. An id
 * that appears in no prose there is a dead end at exactly the moment the tool is least welcome.
 *
 * The check exists because the failure is silent in both directions: adding a rule breaks nothing,
 * and a renamed rule leaves the old name sitting in the README reading like documentation. Neither
 * shows up in a test, because the tests assert on ids they were written with.
 *
 * Substring match, not a table lookup: the README explains each rule in the prose that owns its
 * subject, tagged `[\`rule-id\`]`, rather than in a second list beside it. A separate table would be
 * a duplicate of `src/` that rots the same way this check exists to prevent.
 */
const ROOT = path.join(import.meta.dirname, "..");
const RULE = /rule: "([a-z-]+)"/g;

function ruleIds(): Set<string> {
  const ids = new Set<string>();
  for (const entry of readdirSync(path.join(ROOT, "src"))) {
    if (!entry.endsWith(".ts")) continue;
    const source = readFileSync(path.join(ROOT, "src", entry), "utf8");
    for (const [, id] of source.matchAll(RULE)) if (id !== undefined) ids.add(id);
  }
  return ids;
}

const ids = ruleIds();

// A scan that matches nothing reads exactly like a clean result. It would mean the literal spelling
// this regex depends on has changed — a rule id built from a variable, say — and then the check is
// reporting on a population it never found rather than on the README.
if (ids.size === 0)
  throw new Error(
    `No rule ids found in src/. Findings are no longer declared as \`rule: "some-id"\`, so this ` +
      `check is measuring nothing. Fix the scan in ${path.relative(ROOT, import.meta.filename)}.`,
  );

const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
const undocumented = [...ids].filter((id) => !readme.includes(id)).sort();

if (undocumented.length > 0)
  throw new Error(
    `These rule ids are printed by the CLI and appear nowhere in README.md:\n` +
      `${undocumented.map((id) => `  ${id}`).join("\n")}\n` +
      `README.md ships in the package and is what someone reads when a rule stops their publish. ` +
      `Add each one to the bullet that already explains it, tagged [\`rule-id\`] — do not start a ` +
      `separate table.`,
  );
