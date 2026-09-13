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
import { fileURLToPath } from "node:url";
import { ROW_BUDGET, rowsOf } from "../src/conditions";

const run = promisify(execFile);

/**
 * The filename Node resolved to, from either probe.
 *
 * The probes answer differently: `import.meta.resolve` gives a `file:` URL, `require.resolve` a
 * native path — backslash-separated on Windows. `path.basename` handles both once the URL is
 * converted; splitting on a separator does not. "unresolved" is the probes' sentinel.
 */
function basenameOf(answer: string): string {
  if (answer === "unresolved") return answer;
  return path.basename(answer.startsWith("file:") ? fileURLToPath(answer) : answer);
}

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
      // Both return Node's answer WHOLE. Reducing it here would send the pattern through an
      // escaping layer — `\\` in this template reaches the probe as `\` — which silently turns a
      // separator class into "/" only. `basenameOf` does it in real code instead.
      writeFile(
        path.join(root, "probe.mjs"),
        `const out = {};
         for (const sub of process.argv.slice(2)) {
           try { out[sub] = import.meta.resolve("pkg" + sub.slice(1)); }
           catch { out[sub] = "unresolved"; }
         }
         console.log(JSON.stringify(out));`,
      ),
      writeFile(
        path.join(root, "probe.cjs"),
        `const out = {};
         for (const sub of process.argv.slice(2)) {
           try { out[sub] = require.resolve("pkg" + sub.slice(1)); }
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
        const resolved = JSON.parse(stdout) as Record<string, string>;
        return Object.fromEntries(
          Object.entries(resolved).map(([sub, answer]) => [sub, basenameOf(answer)] as const),
        );
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

/**
 * Builds a map whose outcomes double at every level while its object graph stays linear in depth,
 * by letting both branches of each new independent condition recurse into the level below.
 */
function doubling(depth: number): unknown {
  let left: unknown = "./a.js";
  let right: unknown = "./b.js";
  for (let level = 0; level < depth; level++) {
    const [a, b] = [left, right];
    left = { [`vendor-${level}`]: a, default: b };
    right = { [`vendor-${level}`]: b, default: a };
  }
  return left;
}

it("refuses a map whose outcomes outgrow the budget, instead of enumerating them", () => {
  // The budget is the only thing standing between this walk and unbounded memory, and it used to
  // measure the wrong quantity: the length test sat on each recursive call's OWN array, so a map
  // flattened into fresh arrays and merged upward was never charged for its total. Measured with
  // that bug: 20 levels produced 1,048,576 rows and a 2.6 GB heap and was still not refused, with
  // the level above it an out-of-memory crash rather than a report.
  expect(rowsOf(doubling(12))).toHaveLength(ROW_BUDGET);
  expect(rowsOf(doubling(13))).toBeNull();

  // The depth that proved the old check useless. It must now cost no more than the boundary above,
  // which is what "refused" has to mean for a guard whose purpose is bounding work.
  expect(rowsOf(doubling(20))).toBeNull();
  expect(rowsOf(doubling(40))).toBeNull();
});

it("refuses a map that grows by falling through rather than by resolving", () => {
  // The same explosion with nothing to count. A branch that MISSES does not become an output row,
  // it rejoins the frontier of conjunctions still being tried — so a budget charging only rows
  // watches a number that never moves while the memory doubles at every level. Leaves here are
  // empty objects, which is exactly the shape `{"node": {"browser": …}}` takes for a consumer
  // activating neither.
  let left: unknown = {};
  let right: unknown = {};
  for (let level = 0; level < 20; level++) {
    const [a, b] = [left, right];
    left = { [`vendor-${level}`]: a, default: b };
    right = { [`vendor-${level}`]: b, default: a };
  }
  expect(rowsOf(left)).toBeNull();
});

it("keeps enumerating the wide maps that real packages actually ship", () => {
  // The shape the budget must NOT refuse, and the reason the cost claim is about STRUCTURE rather
  // than about the number of names: a key whose target is a string cannot miss, so it never splits
  // the frontier. The corpus's largest condition object carries 25 names and costs 26 rows.
  const wide: Record<string, unknown> = {};
  for (let index = 0; index < 40; index++) wide[`vendor-${index}`] = `./t${index}.js`;
  wide.default = "./default.js";
  expect(rowsOf(wide)).toHaveLength(41);
});
