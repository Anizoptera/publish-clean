/**
 * What this tool reports and repairs in an `exports`/`imports` map.
 *
 * The proof that authorises every rewrite here lives in `src/conditions.ts`: a map flattens to a
 * decision list, and two maps are equivalent when every jointly satisfiable pair of rows agrees.
 * This file owns the policy on top of it — the canonical condition order and which parts of it a
 * measurement actually forces, the messages, and the repairs. Every transformation is verified
 * with `equivalent` against the value it replaces.
 *
 * Ambient inputs arrive as parameters — no process, filesystem or argv here.
 */
import { equivalent, reachableByAnyConsumer, ROW_BUDGET, rowsOf } from "./conditions";
import type { Finding } from "./finding";
import { isObject } from "./json";
import type { JsonObject } from "./json";

/**
 * The canonical order, most specific first. Each tier's index is its rank; `forced` marks the
 * tiers where a measurement — not a preference — requires the position, which is what lets this
 * tool report a bad order it cannot safely repair without inventing a rule nobody can check.
 *
 * The reasons, each measured for this work and recorded in `docs/exports.md`:
 * - every type checker also activates `node`/`import`/`require`/`default`, so anything ahead of
 *   `types` hands the checker a JavaScript file to read as declarations;
 * - RSC builds also activate `node`/`browser`/`import`;
 * - **Bun and Deno both activate `node`**, so a `bun` or `deno` key placed after `node` is dead;
 * - `module` is active EVEN UNDER `require` in bundlers, so `require` first costs tree-shaking;
 * - anything after `default` is unreachable.
 *
 * `browser`/`node` and `import`/`require` share a tier because their order relative to each other
 * is free — they never co-occurred in any measured profile. A tool must not report a "wrong"
 * order where no constraint binds.
 *
 * The runtime names share ONE tier, so an unmeasured runtime's exact condition set cannot change
 * its rank: every outcome already places it here, ahead of `node` (which Bun and Deno activate).
 * Installing a runtime to measure it buys documentation accuracy, never a different verdict.
 */
const TIERS: readonly { readonly forced: boolean; readonly names: readonly string[] }[] = [
  { forced: true, names: ["types"] },
  { forced: true, names: ["react-server"] },
  {
    forced: true,
    names: [
      "andromeda",
      "arvancloud",
      "azion",
      "bun",
      "convex",
      "deno",
      "edge-light",
      "edge-routine",
      "electron",
      "fastly",
      "kiesel",
      "lagon",
      "moddable",
      "netlify",
      "pythonmonkey",
      "quickjs",
      "quickjs-ng",
      "react-native",
      "rhino",
      "wasmer",
      "workerd",
    ],
  },
  { forced: false, names: ["node-addons"] },
  { forced: false, names: ["browser", "node"] },
  { forced: false, names: ["development", "production"] },
  { forced: false, names: ["module-sync"] },
  { forced: true, names: ["module"] },
  { forced: false, names: ["import", "require"] },
  { forced: true, names: ["default"] },
];

const RANK = new Map(
  TIERS.flatMap((tier, index) => tier.names.map((name) => [name, index] as const)),
);

/** Conditions this tool recognises. Anything else is legitimate and must not be touched. */
const KNOWN = new Set([...RANK.keys(), "style", "source", "worker", "asset", "sass", "svelte"]);

/**
 * TypeScript selects a versioned `types@<selector>` key, so the name is known even though the
 * selector is not parseable without a semver implementation this dependency-free CLI does not
 * have. Such keys rank with `types` and are never reordered against each other.
 */
function conditionRank(name: string): number | undefined {
  return RANK.get(name.startsWith("types@") ? "types" : name);
}

function isKnown(name: string): boolean {
  return KNOWN.has(name) || name.startsWith("types@");
}

/**
 * True when two keys sit in an order a MEASUREMENT forbids — not merely one this tool would have
 * written differently.
 *
 * Only forced tiers count, because a rank inversion on its own is no defect: `{import: X,
 * node: Y}` inverts the canonical rank and is a perfectly good map, since which of the two is
 * "more specific" is the author's call and no consumer is harmed either way. Reporting those
 * would be noise, and a check that fires on correct packages trains everyone to ignore the one
 * that matters.
 *
 * `default` is excluded: everything after it is unreachable, which `reportReachability` already
 * says, naming the dead target rather than the ordering.
 */
function forcedOrderViolation(keys: readonly string[]): boolean {
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++) {
      const earlier = conditionRank(keys[i] ?? "");
      const later = conditionRank(keys[j] ?? "");
      if (earlier === undefined || later === undefined || earlier <= later) continue;
      if (keys[i] === "default" || keys[j] === "default") continue;
      if ((TIERS[earlier]?.forced ?? false) || (TIERS[later]?.forced ?? false)) return true;
    }
  return false;
}

/**
 * Reorders the recognised keys into canonical order while leaving every unrecognised key in the
 * slot it already occupies.
 *
 * Pinning the unknowns is not caution about the proof — the proof handles them correctly on its
 * own, since a free variable makes almost every move across one non-equivalent. It is about the
 * DIFF: moving a key this tool cannot explain produces a change the author cannot review, and
 * the whole value of an automatic rewrite is that the author can read it and agree.
 */
function canonicalOrder(keys: readonly string[]): string[] {
  const sorted = keys
    .filter((key) => conditionRank(key) !== undefined)
    .map((key, index) => ({ key, index }))
    .sort((a, b) => (conditionRank(a.key) ?? 0) - (conditionRank(b.key) ?? 0) || a.index - b.index)
    .map((entry) => entry.key);
  let next = 0;
  return keys.map((key) => (conditionRank(key) === undefined ? key : (sorted[next++] ?? key)));
}

/**
 * Copies a condition object key by key.
 *
 * NEVER `Object.assign`: a condition may legally be named `__proto__`, `JSON.parse` keeps it as
 * an ordinary own property, and assignment hands it to `Object.prototype`'s setter instead —
 * which publishes a manifest silently missing a branch while the copy answers to every key that
 * branch contained. Measured on Node 24.20.0; spread and explicit definition both round-trip.
 */
function reorder(node: JsonObject, keys: readonly string[]): JsonObject {
  const copy: JsonObject = {};
  for (const key of keys) Object.defineProperty(copy, key, { ...OWN, value: node[key] });
  return copy;
}

const OWN = { configurable: true, enumerable: true, writable: true } as const;

function without(node: JsonObject, omit: string): JsonObject {
  return reorder(
    node,
    Object.keys(node).filter((key) => key !== omit),
  );
}

/**
 * Repairs one target node, bottom up, and reports what it could not repair.
 *
 * Every transformation is verified with `equivalent` against the value it replaces, so the
 * contract of this whole module is unconditional: **a healed map resolves exactly as the
 * original did, for every consumer that could ever exist.** Nothing here is a semantic fix.
 * That is what makes the verification at the end of `healMap` a real check rather than a
 * restatement — there is no intended difference for it to have to excuse.
 */
function healNode(node: unknown, where: string, findings: Finding[]): unknown {
  if (Array.isArray(node)) {
    findings.push({
      rule: "exports-fallback-array",
      consequence: "waste",
      healed: false,
      where,
      message:
        `A fallback array resolves differently across runtimes: Bun fails on ` +
        `[null, …] and on ["not-relative", …] where Node and Deno resolve the next entry. ` +
        `Nothing inside this value is rewritten, and no sibling key of it is either. ` +
        `Replace the array with the single target you mean, if you can.`,
    });
    return node;
  }
  if (!isObject(node)) return node;

  // Bottom up: a child that collapses to a string can make its parent collapsible in turn.
  // `changed` tracks whether anything actually moved, so an untouched map is returned AS the
  // object it came in as. The caller compares by identity to decide whether the manifest needs
  // rewriting at all, and a copy that merely looks the same would report a repair on every
  // package carrying a condition map — measured at 81.5% of them before this was tracked.
  let changed = false;
  let current: JsonObject = reorder(node, Object.keys(node));
  for (const key of Object.keys(current)) {
    const healed = healNode(current[key], `${where}[${JSON.stringify(key)}]`, findings);
    changed ||= healed !== current[key];
    current[key] = healed;
  }

  const keys = Object.keys(current);
  const repaired = () => (changed ? current : node);
  if (keys.length === 0) return repaired();

  // A map holding a fallback array anywhere below is frozen whole: the proof that authorises
  // every rewrite here is relative to a resolver, and the resolvers disagree about arrays.
  if (keys.some((key) => containsArray(current[key]))) return repaired();

  for (const key of keys) {
    if (!isKnown(key))
      findings.push({
        rule: "exports-unknown-condition",
        consequence: "waste",
        healed: false,
        where: `${where}[${JSON.stringify(key)}]`,
        message:
          `No consumer measured for this tool activates ${JSON.stringify(key)} by default, so ` +
          `only a project that configures it deliberately takes this branch. That is legitimate ` +
          `— private conditions appear in 2.5% of published packages — and nothing here is ` +
          `reordered across it or removed. Reported so a typo cannot hide as a private name.`,
      });
  }

  // Provably inert keys. A key is inert when deleting it changes nothing for ANY consumer,
  // which is exactly a `node` branch that repeats what `default` already gives.
  for (const key of keys) {
    if (Object.keys(current).length < 2) break;
    const candidate = without(current, key);
    if (!equivalent(current, candidate)) continue;
    findings.push({
      rule: "exports-inert-condition",
      consequence: "waste",
      healed: true,
      where: `${where}[${JSON.stringify(key)}]`,
      message:
        `This condition resolves to the same target every consumer would reach without it, so ` +
        `it changes nothing and tells nobody anything. Removed from the published manifest. ` +
        `Delete it from your package.json to stop this report.`,
    });
    current = candidate;
    changed = true;
  }

  // Canonical order, applied only when the permutation is provably neutral.
  const ordered = canonicalOrder(Object.keys(current));
  if (ordered.join("\0") !== Object.keys(current).join("\0")) {
    const permuted = reorder(current, ordered);
    if (equivalent(current, permuted)) {
      findings.push({
        rule: "exports-condition-order",
        consequence: "waste",
        healed: true,
        where,
        message:
          `Reordered to ${ordered.map((key) => JSON.stringify(key)).join(", ")}, which resolves ` +
          `identically for every possible consumer — proven, not assumed. Most specific first: ` +
          `types, then framework and runtime names, then environment, then module system, then ` +
          `default. Apply the same order in your package.json to stop this report.`,
      });
      current = permuted;
      changed = true;
    } else if (forcedOrderViolation(Object.keys(current))) {
      findings.push({
        rule: "exports-condition-order-unsafe",
        consequence: "breaks",
        healed: false,
        where,
        message:
          `These keys are out of canonical order and reordering them would change what some ` +
          `consumer resolves, so this tool will not do it: ` +
          `${Object.keys(current)
            .map((key) => JSON.stringify(key))
            .join(", ")}. ` +
          `The order that holds for every measured consumer is ` +
          `${ordered.map((key) => JSON.stringify(key)).join(", ")}. ` +
          `Because a checker also activates node/import/require, and a bundler activates ` +
          `module even under require, and Bun and Deno both activate node, the current order ` +
          `hands at least one of them a file meant for another. Fix it by hand: the branches ` +
          `differ, so only you know which target each consumer should get.`,
      });
    }
  }

  // `{"default": X}` is X, written longer.
  const remaining = Object.keys(current);
  if (remaining.length === 1 && remaining[0] === "default") {
    const inner = current.default;
    if (equivalent(current, inner)) {
      findings.push({
        rule: "exports-redundant-default",
        consequence: "waste",
        healed: true,
        where,
        message:
          `An object whose only key is "default" resolves exactly as the target it wraps. ` +
          `Replaced with that target in the published manifest; do the same in your package.json.`,
      });
      return inner;
    }
  }

  return repaired();
}

function containsArray(node: unknown): boolean {
  if (Array.isArray(node)) return true;
  if (!isObject(node)) return false;
  return Object.values(node).some(containsArray);
}

/**
 * Reports the branches no consumer can take and the consumers no branch serves.
 *
 * The two are duals and both fall out of the same rows, which is why they are computed together:
 * a declared target that appears in no row is code nobody runs, and a satisfiable row that
 * resolves nothing is a consumer that gets `ERR_PACKAGE_PATH_NOT_EXPORTED`. Reading one as the
 * other is the natural mistake, so neither is stated without the other beside it.
 *
 * Returns whether the map could be enumerated at all, so the caller can freeze an unenumerable one
 * without paying for a second walk to discover the same thing.
 */
function reportReachability(node: unknown, where: string, findings: Finding[]): boolean {
  const rows = rowsOf(node);
  if (!rows) {
    findings.push({
      rule: "exports-too-complex",
      consequence: "waste",
      healed: false,
      where,
      message:
        `This map has more distinct resolution outcomes than this tool will enumerate ` +
        `(${ROW_BUDGET}), so nothing inside it was verified, reordered or removed. It is ` +
        `published exactly as written.`,
    });
    return false;
  }

  const reached = new Set(
    rows.flatMap((row) => (row.target.kind === "file" ? [row.target.file] : [])),
  );
  const declared: string[] = [];
  collectStrings(node, declared);
  for (const target of declared)
    if (!reached.has(target))
      findings.push({
        rule: "exports-unreachable-branch",
        consequence: "waste",
        healed: false,
        where,
        message:
          `No consumer can ever resolve ${JSON.stringify(target)}: it sits after a key that ` +
          `always matches, or behind a combination of conditions that cannot occur together. ` +
          `It is dead code in the manifest — delete the branch, or move it ahead of the key ` +
          `that shadows it.`,
      });

  // WARNING, not an error, and the measurement is the whole reason. This fires on 25.5% of the
  // 659 published packages on this machine, and the samples are dominated by shapes the author
  // chose: `@types/ws` exports only a `types` branch because runtime resolution is MEANT to fail,
  // and a package offering only `node` and `browser` has decided not to serve anything else.
  // Refusing to publish a quarter of the ecosystem would teach every reader to ignore this tool.
  // `--strict` is the ruled way to demand otherwise.
  if (rows.some((row) => row.target.kind === "miss" && reachableByAnyConsumer(row.literals)))
    findings.push({
      rule: "exports-unresolvable",
      consequence: "waste",
      healed: false,
      where,
      message:
        `Some consumer resolves nothing here and fails with ERR_PACKAGE_PATH_NOT_EXPORTED. ` +
        `Edge runtimes (workerd, edge-light, netlify, fastly) activate neither "node" nor ` +
        `"browser", and a bundler targeting neither activates neither, so a map built from ` +
        `environment names alone leaves them with no branch at all. Add a "default" key as the ` +
        `last entry, pointing at the build that works anywhere. Ignore this if excluding those ` +
        `consumers is deliberate — a types-only package resolves nothing at run time by design.`,
    });
  return true;
}

/**
 * Targets whose reachability this tool can actually answer.
 *
 * A fallback array is deliberately NOT descended into. It resolves to one opaque row, so every
 * string inside it would otherwise appear in no row and be reported as dead — which measured as
 * the entire population of this rule's hits on real packages: `acorn` and `escalade` wrap their
 * whole entry point in an array, and every target they declare was called unreachable. Those
 * targets are unanalysed, not dead, and silence is the only honest answer for them.
 */
function collectStrings(node: unknown, out: string[]): void {
  if (typeof node === "string") out.push(node);
  else if (isObject(node)) for (const value of Object.values(node)) collectStrings(value, out);
}

export interface ExportsReview {
  /** The manifest to publish: the input itself when nothing was repaired. */
  readonly manifest: JsonObject;
  readonly findings: readonly Finding[];
}

/**
 * Verifies — and, unless asked not to, repairs — the `exports` and `imports` of a manifest about
 * to be published.
 *
 * The input is never modified, and `manifest` is the input object itself when nothing changed, so
 * a caller can tell a real repair from a copy by identity.
 *
 * Each repaired node is asserted equivalent to the one it replaces before it is returned, so a
 * defect in any transformation above fails HERE, naming itself as this tool's bug, rather than in
 * a stranger's build.
 *
 * This is the ONLY funnel a rewrite passes through, and `cli.ts` then proves the archive's manifest
 * is byte-identical to the cleaned one — so re-resolving every subpath after the rewrite would
 * re-derive this same verdict from this same code on these same values, which is one piece of
 * evidence counted twice. What that would genuinely add, a check on the row algebra itself, comes
 * from an oracle that cannot share a mistake with it: real Node, in `test/conditions.test.ts`.
 *
 * `heal: false` keeps every finding and withholds only the rewrite, which is why those findings
 * are corrected to stop claiming a repair the published artifact does not carry.
 */
export function reviewExports(pkg: JsonObject, options: { readonly heal: boolean }): ExportsReview {
  const { heal } = options;
  const findings: Finding[] = [];
  const analyse = (node: unknown, where: string): unknown => {
    // A map whose outcomes cannot be enumerated is frozen whole, exactly as one containing a
    // fallback array is: every rewrite below is authorised by that enumeration, so without it
    // there is no proof to rewrite under. `exports-too-complex` has already told the author the
    // map ships as written, and healing it anyway would then fail the equivalence assert below —
    // reporting a defect in this tool for a package that is merely large.
    if (!reportReachability(node, where, findings)) return node;
    const first = findings.length;
    const healed = healNode(node, where, findings);
    if (!equivalent(node, healed))
      throw new Error(
        `publish-clean defect: repairing ${where} changed what a consumer resolves. This is a ` +
          `bug in publish-clean, not in your package; publish with --no-heal meanwhile.`,
      );
    if (heal) return healed;
    for (let index = first; index < findings.length; index++) {
      const finding = findings[index];
      if (finding?.healed) findings[index] = { ...finding, healed: false };
    }
    return node;
  };

  let result: JsonObject = pkg;
  for (const field of ["exports", "imports"]) {
    const value = pkg[field];
    if (value === undefined || value === null) continue;
    // `exports` is a subpath map when any key starts with `.`, and a single condition object
    // otherwise; mixing the two is a package-configuration error `reviewDeclaredFiles` refuses.
    // `imports` is always a subpath map.
    const subpaths =
      isObject(value) &&
      (field === "imports" || Object.keys(value).some((key) => key.startsWith(".")));
    if (!subpaths) {
      const healed = analyse(value, field);
      if (healed !== value) result = { ...result, [field]: healed };
      continue;
    }
    const rebuilt: JsonObject = {};
    let changed = false;
    for (const [key, node] of Object.entries(value)) {
      const healed = analyse(node, `${field}[${JSON.stringify(key)}]`);
      changed ||= healed !== node;
      Object.defineProperty(rebuilt, key, { ...OWN, value: healed });
    }
    if (changed) result = { ...result, [field]: rebuilt };
  }
  return { manifest: result, findings };
}
