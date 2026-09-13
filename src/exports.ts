/**
 * What this tool reports and repairs in an `exports`/`imports` map.
 *
 * The proof that authorises every rewrite here lives in `src/conditions.ts`: a map flattens to a
 * decision list, and two maps are equivalent when every jointly satisfiable pair of rows agrees.
 * This file owns the policy on top of it — the canonical condition order and which parts of it a
 * measurement actually forces, the messages, and the repairs. Every transformation is verified with
 * `equivalent` against the value it replaces — except `repairTypes`, the one rewrite that INTENDS a
 * difference and therefore states its own warrant instead of borrowing that proof.
 *
 * Ambient inputs arrive as parameters — no process, filesystem or argv here.
 */
import { equivalent, reachableByAnyConsumer, ROW_BUDGET, rowsOf } from "./conditions";
import { checkerFinds } from "./declared";
import type { Consequence, Finding } from "./finding";
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
 * What it costs a consumer that two keys sit in an order a MEASUREMENT forbids — not merely one
 * this tool would have written differently — or `undefined` when the order is sound.
 *
 * Only forced tiers count, because a rank inversion on its own is no defect: `{import: X,
 * node: Y}` inverts the canonical rank and is a perfectly good map, since which of the two is
 * "more specific" is the author's call and no consumer is harmed either way. Reporting those
 * would be noise, and a check that fires on correct packages trains everyone to ignore the one
 * that matters.
 *
 * `default` is excluded: everything after it is unreachable, which `reportReachability` already
 * says, naming the dead target rather than the ordering.
 *
 * The key listed LATER is the one that LOSES, because a consumer activating both takes the first
 * key it matches — and only a forced key LOSING is a defect. Forcedness is one-directional: it
 * says a consumer activating this key must not be handed another key's target, so the key winning
 * is that constraint being SATISFIED. Reporting the other direction refused `@aws-sdk/core`,
 * `@smithy/core`, `underscore` and every package built like them, all over `module` placed ahead
 * of `node` — which is the author ranking a bundler above a runtime, the call this function exists
 * to leave alone.
 *
 * What the losing key would have given the consumer then decides the consequence. One loss is
 * already repaired before this runs and one costs nothing a publish should be refused over:
 *
 * - `types` names a file nobody executes, and `repairTypes` owns it: a checker that misses the key
 *   resolves the JS target and reads the `.d.ts` sitting beside it, so the loss exists only where
 *   no such declaration ships, and there the key is hoisted rather than reported here.
 * - `module` losing to `import` hands a bundler the ESM entry point meant for Node rather than the
 *   ESM build meant for bundlers. A tuned variant, not another module system. Losing it to
 *   `require` is the opposite and stays fatal: that one serves CJS where ESM was available.
 */
function forcedOrderConsequence(node: JsonObject): Consequence | undefined {
  const keys = Object.keys(node);
  let worst: Consequence | undefined;
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++) {
      const winner = keys[i] ?? "";
      const loser = keys[j] ?? "";
      const earlier = conditionRank(winner);
      const later = conditionRank(loser);
      if (earlier === undefined || later === undefined || earlier <= later) continue;
      // Only `default` can win a rank inversion, holding the last rank, and a key stranded behind
      // it is `reportReachability`'s to name.
      if (winner === "default") continue;
      if (!(TIERS[later]?.forced ?? false)) continue;
      // The winner costs nobody the loser's specificity when its own subtree dispatches on the
      // loser: a consumer activating both enters the winner and meets the loser inside. One level
      // is enough to decide it, because a misordering WITHIN that subtree is a node of its own and
      // is reported when the walk reaches it. `@emotion/styled` is the shape — `development` ahead
      // of `edge-light`, and `development` re-dispatching on `edge-light`, `worker` and `workerd`,
      // so a dev build on an edge runtime gets the file built for it and the canonical order would
      // hand it a production build instead.
      const subtree = node[winner];
      if (isObject(subtree) && Object.hasOwn(subtree, loser)) continue;
      // Two keys carrying the same target cannot be told apart by any consumer, so their order is
      // not observable at all. `node-fetch-native` lists eleven runtime names ahead of `node`,
      // every one of them the same file, and a serialised comparison is the whole test: inside a
      // condition map key ORDER is semantic, so two subtrees agree exactly when they agree
      // key-for-key in sequence.
      if (JSON.stringify(subtree) === JSON.stringify(node[loser])) continue;
      // A `types` loser belongs to `repairTypes`, which has already run: it removed the branch when
      // nothing fulfils it and hoisted it when the archive's declarations were unreachable. What
      // survives is a map where a checker DOES reach declarations — beside the winner's target, or
      // beside a sibling's, which is the case hoisting cannot repair without taking that sibling's
      // answer away. `types` first wins for EVERY checker, so there is no position that serves the
      // consumer who has nothing without changing the one who already has something.
      if (later === conditionRank("types")) continue;
      if (loser === "module" && winner === "import") worst ??= "waste";
      else return "breaks";
    }
  return worst;
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
 * Every string a consumer could resolve through this node. Its one caller has already refused any
 * node holding a fallback array, so an array cannot appear below — were that guard ever relaxed,
 * this walk would have to grow an array branch, because a member of one is a target some resolver
 * really takes and skipping it reports "nothing here declares anything" about a branch that does.
 */
function leaves(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (isObject(node)) for (const value of Object.values(node)) leaves(value, out);
  return out;
}

/**
 * Repairs a `types` condition no type checker can read declarations through — the ONE rewrite in
 * this file that deliberately changes what a consumer resolves.
 *
 * It is kept out of `healNode`, and out of the equivalence assert in `reviewExports` that guards
 * it, because the whole value of that assert is having nothing to excuse: every rewrite it covers
 * is invisible to every consumer that could ever exist, and one intended exception smuggled in
 * among them would make it a formality. Here the change IS the repair, so it carries its own
 * warrant instead.
 *
 * Only a type checker activates `types`, which is what makes both moves invisible to everything
 * that EXECUTES the package. Which one applies follows from a single fact about the archive —
 * what a checker actually finds at a target (`checkerFinds`):
 *
 * - the target names JavaScript with no declaration file beside it, so the branch promises an API
 *   the archive does not carry and a checker reads that JavaScript as the package's declarations,
 *   typing everything `any`. The promise is REMOVED, and the checker then reports an untyped
 *   package — true, and actionable, where an invented API is neither.
 * - the target names real declarations that a key ahead of it hides, and nothing that key offers a
 *   checker carries declarations either, so what the author built is unreachable by anybody. The
 *   key is HOISTED to the front of its own object.
 *
 * Where the key ahead DOES lead to declarations nothing is moved: the checker already has an API,
 * the adjacent declarations may legitimately differ per module format, and exchanging one working
 * answer for another is not a repair. That is the majority — 80 of the 103 packages the ordering
 * rule fired on across 3674 installed published names type-check correctly today through exactly
 * that fallback.
 *
 * "Leads nowhere" is read from the ARCHIVE, which is why an unrecognised condition ahead stops the
 * move rather than licensing it: a private name's target may be absent precisely because it is not
 * meant for the published tree, and the archive cannot tell that from a mistake.
 *
 * Both report `breaks`, because a consumer getting the wrong API or none is a breakage, and both
 * print `[error]` however mild the word "types" sounds. Neither aborts: the published artifact is
 * correct. `--no-heal` withholds the rewrite and turns both findings fatal, which is the only
 * reading of that flag — the author asked to publish their own bytes unaltered.
 */
/**
 * Whether a condition name is one only a type checker activates — the whole warrant for
 * `repairTypes` being allowed to change what a consumer resolves.
 *
 * Asked through `conditionRank` rather than by comparing the name, because `types@<selector>` ranks
 * WITH `types` (see `conditionRank`) and a checker picks it the same way. A spelling of this test
 * written from the names in view — `key === "types"`, or a pattern over the literal — silently
 * exempts every package using the versioned form, and the exemption looks exactly like a package
 * with nothing to repair. Exported so nothing has to write that second spelling.
 */
export function isTypesCondition(key: string): boolean {
  return conditionRank(key) === conditionRank("types");
}

function repairTypes(
  node: unknown,
  where: string,
  findings: Finding[],
  names: ReadonlySet<string>,
): unknown {
  const hoist = (value: JsonObject, keys: readonly string[], at: string): JsonObject => {
    const hidden = keys.filter(isTypesCondition);
    if (hidden.length === 0 || isTypesCondition(keys[0] ?? "")) return value;
    // Reordering around a fallback array is the one move this file never makes, because the
    // resolvers disagree about what an array resolves to and the author cannot check the diff
    // against a rule nobody agrees on. Removing a dead branch is unaffected and still happens.
    if (containsArray(value)) return value;
    const ahead = keys.slice(0, keys.indexOf(hidden[0] ?? ""));
    // A key stranded behind `default` is `reportReachability`'s, which has already named it — the
    // same split `forcedOrderConsequence` keeps. Hoisting it too would leave the run holding two
    // findings about one key, one of them saying it is dead after this made it live.
    if (ahead.includes("default")) return value;
    // An unrecognised condition ahead is never moved across, the same rule `canonicalOrder` keeps:
    // this tool cannot know who activates a private name or what they should get. `zod` puts
    // `@zod/source` first at every subpath, pointing at TypeScript this package does not even ship —
    // so the archive says "no declarations there" while a checker configured with that condition is
    // meant to take it, and hoisting would hand it the built `.d.cts` instead of the source.
    if (ahead.some((key) => !isKnown(key))) return value;
    const reached = (key: string): boolean =>
      leaves(value[key]).some((target) => checkerFinds(names, target) === "declarations");
    // Nothing to make reachable unless the branch really leads to declarations the archive carries.
    if (!hidden.some(reached)) return value;
    if (ahead.some(reached)) return value;
    findings.push({
      rule: "types-branch-unreachable",
      consequence: "breaks",
      healed: true,
      where: at,
      message:
        `${hidden.map((key) => JSON.stringify(key)).join(", ")} sits behind ` +
        `${ahead.map((key) => JSON.stringify(key)).join(", ")}, and a type checker activates those ` +
        `too, so it takes one of them and finds no declarations there or beside them — the ` +
        `declarations this branch names reach nobody. Moved to the front of this object in the ` +
        `published manifest; no runtime activates "types", so nothing that executes your package ` +
        `can tell. Put "types" first in your package.json to stop this report.`,
    });
    return reorder(value, [...hidden, ...keys.filter((key) => !isTypesCondition(key))]);
  };

  // `undefined` means "delete this key": the branch promises declarations that do not exist.
  const visit = (value: unknown, at: string, inside: boolean): unknown => {
    if (typeof value === "string") {
      if (!inside || checkerFinds(names, value) !== "javascript") return value;
      findings.push({
        rule: "types-branch-not-declarations",
        consequence: "breaks",
        healed: true,
        where: at,
        message:
          `This "types" condition resolves to ${JSON.stringify(value)}, which is not a declaration ` +
          `file and has none shipped beside it, so a checker taking this branch reads JavaScript as ` +
          `the package's API. Removed from the published manifest, which leaves a checker reporting ` +
          `an untyped package instead of the wrong one. Build the declarations and point the branch ` +
          `at them, or delete the condition yourself to stop this report.`,
      });
      return undefined;
    }
    if (!isObject(value)) return value;
    const rebuilt: JsonObject = {};
    let changed = false;
    for (const [key, child] of Object.entries(value)) {
      const kept = visit(child, `${at}[${JSON.stringify(key)}]`, inside || isTypesCondition(key));
      changed ||= kept !== child;
      if (kept !== undefined) Object.defineProperty(rebuilt, key, { ...OWN, value: kept });
    }
    // An object emptied by the pruning above promises nothing either, so the key holding it goes
    // the same way. One that arrived empty is the author's own "not exported" and stays.
    const keys = Object.keys(rebuilt);
    if (keys.length === 0 && Object.keys(value).length > 0) return undefined;
    return hoist(changed ? rebuilt : value, keys, at);
  };

  return visit(node, where, false);
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
    } else {
      const consequence = forcedOrderConsequence(current);
      if (consequence !== undefined)
        findings.push({
          rule: "exports-condition-order-unsafe",
          consequence,
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
            (consequence === "breaks"
              ? `Because a checker also activates node/import/require, and a bundler activates ` +
                `module even under require, and Bun and Deno both activate node, the current ` +
                `order hands at least one of them a file meant for another. Fix it by hand: the ` +
                `branches differ, so only you know which target each consumer should get.`
              : `What is out of place here costs no consumer another runtime's build: "module" is ` +
                `a bundler's tuned ESM variant losing to the ESM entry point beside it, so both ` +
                `sides of the inversion are ES modules. Fix it by hand — the branches differ, so ` +
                `only you know which target each consumer should get — or use --strict to refuse ` +
                `a publish over it.`),
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
 * Each neutrally repaired node is asserted equivalent to the one it replaces before it is returned,
 * so a defect in any transformation above fails HERE, naming itself as this tool's bug, rather than
 * in a stranger's build. `repairTypes` is the one rewrite that intends a difference, which is why it
 * runs outside that assert and states its own warrant — `files` is the archive's packed names, the
 * only evidence it acts on.
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
export function reviewExports(
  pkg: JsonObject,
  options: { readonly files: ReadonlySet<string>; readonly heal: boolean },
): ExportsReview {
  const { files, heal } = options;
  const findings: Finding[] = [];
  const analyse = (node: unknown, where: string): unknown => {
    const first = findings.length;
    /** The author's own bytes, with every finding since `first` corrected to stop claiming a repair
     * the published artifact does not carry. An unrepaired breakage is then what `isFatal` stops. */
    const withheld = (): unknown => {
      for (let index = first; index < findings.length; index++) {
        const finding = findings[index];
        if (finding?.healed) findings[index] = { ...finding, healed: false };
      }
      return node;
    };
    // The one deliberate semantic change, taken BEFORE the neutral rewrites so they see the map a
    // consumer will actually resolve — a removed branch can leave the rest in canonical order, and
    // a hoisted one can make another key provably inert.
    //
    // Ahead of the enumeration gate too, and that ordering is load-bearing: this check ran on every
    // map before it moved here, and its warrant is that only a checker activates `types`, which
    // owes nothing to the row algebra. Running it after the gate would leave a fatal rule silent on
    // exactly the maps too large to reason about — a guard whose absence is invisible.
    const repaired = repairTypes(node, where, findings, files) ?? {};
    // A map whose outcomes cannot be enumerated is frozen against the rewrites BELOW: each of those
    // is authorised by that enumeration, so without it there is no proof to act under.
    // `exports-too-complex` has already told the author the map ships as written, and healing it
    // anyway would then fail the equivalence assert — reporting a defect in this tool for a package
    // that is merely large.
    if (!reportReachability(node, where, findings)) return heal ? repaired : withheld();
    const healed = healNode(repaired, where, findings);
    if (!equivalent(repaired, healed))
      throw new Error(
        `publish-clean defect: repairing ${where} changed what a consumer resolves. This is a ` +
          `bug in publish-clean, not in your package; publish with --no-heal meanwhile.`,
      );
    return heal ? healed : withheld();
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
