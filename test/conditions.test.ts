/**
 * Checks the decision list against the resolver it claims to model: real Node, asked with real
 * condition sets.
 *
 * Every rewrite this tool applies to a published `exports` map is authorised by `rowsOf` — so a
 * flattening bug does not produce a failing test somewhere, it produces a manifest that resolves
 * differently for a stranger. Hand-written expectations cannot catch that, because they are
 * written from the same reading of the specification as the code. Node is the only instrument
 * that can disagree, and it does disagree with the published specification in places
 * (`docs/exports.md`), which is exactly why it, and not the prose, is the oracle here.
 *
 * A brute-force enumerator over condition subsets was the other candidate and is weaker: it would
 * still encode this file's own reading of first-match semantics, so agreement would prove only
 * that the same belief was written twice.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rowsOf } from "../src/conditions";

const run = promisify(execFile);

/** Targets are never loaded — resolution is the whole question — so the files may be empty. */
const TARGETS = [
  "deno.js",
  "node.js",
  "default.js",
  "nested-browser.js",
  "dual-esm.js",
  "dual-cjs.js",
  "browser.js",
  "source.ts",
];

/**
 * Shapes whose resolution is decided by ORDER, NESTING or a block — the three things `flatten`
 * claims to model. A fallback array is deliberately absent: it flattens to an opaque target
 * because the runtimes disagree about arrays, so Node's answer would not be the answer.
 */
const MAP: Record<string, unknown> = {
  // First match wins, and `deno` must precede `node` because Deno activates both.
  "./ordered": { deno: "./deno.js", node: "./node.js", default: "./default.js" },
  // An inner object that resolves nothing falls through to the NEXT SIBLING, not to failure.
  "./nested": { node: { browser: "./nested-browser.js" }, default: "./default.js" },
  // `null` blocks the subpath for whoever activates that condition, and only for them.
  "./blocked": { node: null, default: "./default.js" },
  // Anything after `default` is unreachable: `default` matches every consumer.
  "./after-default": { default: "./default.js", node: "./node.js" },
  // The exclusion the row algebra folds in at bind time.
  "./dual": { import: "./dual-esm.js", require: "./dual-cjs.js" },
  // An unrecognised name is a free variable, never assumed inactive by the algebra.
  "./unknown": { "@zod/source": "./source.ts", default: "./default.js" },
  // No `default`: a consumer activating neither key gets nothing.
  "./split": { browser: "./browser.js", node: "./node.js" },
};

/**
 * Node's own defaults, measured rather than assumed (`docs/exports.md`), plus whatever the run
 * adds through `--conditions`. `default` is not listed: it matches unconditionally, which is how
 * `flatten` treats it too.
 */
const PROFILES = [
  { extra: [], active: ["node", "import", "module-sync", "node-addons"], require: false },
  {
    extra: ["browser"],
    active: ["node", "import", "module-sync", "node-addons", "browser"],
    require: false,
  },
  {
    extra: ["deno"],
    active: ["node", "import", "module-sync", "node-addons", "deno"],
    require: false,
  },
  { extra: [], active: ["node", "require", "module-sync", "node-addons"], require: true },
] as const;

/**
 * What the decision list says this consumer gets.
 *
 * Throws when no row matches, which is the point: the rows are claimed to PARTITION the condition
 * space, and every equivalence proof rests on that. A profile falling through every row falsifies
 * the claim rather than quietly returning nothing.
 */
function byRows(node: unknown, active: ReadonlySet<string>): string {
  const rows = rowsOf(node);
  if (rows === null) throw new Error("map exceeded the row budget");
  for (const row of rows) {
    let matches = true;
    for (const [name, required] of row.literals)
      if (active.has(name) !== required) {
        matches = false;
        break;
      }
    if (!matches) continue;
    // Node cannot distinguish a blocked target from an unmatched one — both refuse the subpath.
    // The algebra keeps them apart for a different question: what a REWRITE is allowed to assume.
    return row.target.kind === "file" ? path.basename(row.target.file) : "unresolved";
  }
  throw new Error("the rows do not cover this consumer, so they are not a partition");
}

it("resolves every shape the way Node does, under every measured condition set", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publish-clean-conditions-"));
  try {
    const pkg = path.join(root, "node_modules", "pkg");
    await mkdir(pkg, { recursive: true });
    await Promise.all([
      writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "pkg", exports: MAP })),
      ...TARGETS.map((name) => writeFile(path.join(pkg, name), "")),
      // Two probes, because the module system is what activates `import` or `require`; no flag
      // can set them, so the consumer has to genuinely be one or the other.
      writeFile(
        path.join(root, "probe.mjs"),
        `const out = {};
         for (const sub of process.argv.slice(2)) {
           try { out[sub] = import.meta.resolve("pkg" + sub.slice(1)).split("/").pop(); }
           catch { out[sub] = "unresolved"; }
         }
         console.log(JSON.stringify(out));`,
      ),
      writeFile(
        path.join(root, "probe.cjs"),
        `const out = {};
         for (const sub of process.argv.slice(2)) {
           try { out[sub] = require.resolve("pkg" + sub.slice(1)).split("/").pop(); }
           catch { out[sub] = "unresolved"; }
         }
         console.log(JSON.stringify(out));`,
      ),
    ]);

    const subpaths = Object.keys(MAP);
    const answers = await Promise.all(
      PROFILES.map(async (profile) => {
        const conditions = profile.extra.map((name) => `--conditions=${name}`);
        const probe = profile.require ? "probe.cjs" : "probe.mjs";
        const { stdout } = await run(process.execPath, [...conditions, probe, ...subpaths], {
          cwd: root,
        });
        return JSON.parse(stdout) as Record<string, string>;
      }),
    );

    for (const [index, profile] of PROFILES.entries()) {
      const active = new Set(profile.active);
      const fromNode = answers[index] ?? {};
      // Control. A probe that cannot see the package answers "unresolved" to everything, and the
      // rows agree wherever they also fail — a green comparison measuring nothing. Both of these
      // carry a `default`, so every consumer that reached the package resolves them.
      expect(fromNode["./ordered"]).not.toBe("unresolved");
      expect(fromNode["./unknown"]).not.toBe("unresolved");

      const fromRows = Object.fromEntries(
        subpaths.map((sub) => [sub, byRows(MAP[sub], active)] as const),
      );
      // Compared whole, so a disagreement names the subpath AND both answers.
      expect({ profile: profile.active, ...fromRows }).toEqual({
        profile: profile.active,
        ...fromNode,
      });
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
