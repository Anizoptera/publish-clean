/**
 * Proving what an `exports`/`imports` condition map resolves to, for every consumer that could
 * ever exist.
 *
 * A consumer does not activate one condition. It activates a SET — webpack activates six — and
 * then takes the first key of the package's object that is in that set. The order written in the
 * manifest picks the winner, so no reorder is cosmetic and nothing may be removed on the strength
 * of a rule of thumb. This file answers only "what does this map do"; `src/exports.ts` owns what
 * this tool then says and rewrites.
 *
 * THE PROOF. Walking a map top to bottom yields a DECISION LIST: rows of
 * `{conjunction of condition literals → target}` that are mutually exclusive and cover every
 * possible active set. Two maps are equivalent exactly when every pair of rows whose conjunctions
 * are jointly satisfiable carries the same target, and satisfiability of two pure conjunctions is
 * a scan for one name bound both ways. The cost is linear in the map's STRUCTURE.
 *
 * The rejected alternative was enumerating the 2^n subsets of the names present. It is
 * exponential in the names rather than the structure, so it needs a cap and answers "not proven"
 * on real packages — a survey of this machine's dependency closure holds a condition object with
 * 25 distinct names, which is 33 million subsets. A closed-form shortcut ("a key is inert when
 * every later key has its target") was rejected as WRONG: in `{import: X, require: Y, default: X}`
 * the `import` key IS inert, because `require` cannot be active alongside it, and the shortcut
 * says otherwise.
 *
 * Ambient inputs arrive as parameters — no process, filesystem or argv here.
 */
import { isObject } from "./json";

/**
 * What a branch yields. `blocked` (an explicit `null`) and `miss` (no key matched) both fail
 * resolution, but they are kept distinct so a transformation has to prove the stronger claim:
 * treating them as equal would let `{node: null, default: "./a.js"}` lose its `node` branch,
 * which is a real change for a consumer that activates `node`.
 */
type Target =
  | { readonly kind: "blocked" }
  | { readonly kind: "file"; readonly file: string }
  | { readonly kind: "miss" }
  | { readonly kind: "opaque"; readonly key: string };

/** A conjunction: each named condition is required to be active (`true`) or inactive (`false`). */
export type Literals = ReadonlyMap<string, boolean>;

export interface Row {
  readonly literals: Literals;
  readonly target: Target;
}

/**
 * Pairs that never co-occur, folded in as the rows are built so that a contradictory branch
 * produces no row at all.
 *
 * `import`/`require` is Node's own documented split and held across all 20 consumer profiles
 * measured for this work. `development`/`production` is documented as mutually exclusive.
 * Nothing else may be assumed: an unrecognised name is a free variable, which is what makes
 * `{"X": "./a.js", "default": "./a.js"}` provably removable whatever X means, while
 * `{"X": "./src/index.ts", "default": "./dist/index.js"}` is untouchable.
 */
const EXCLUSIVE: readonly (readonly [string, string])[] = [
  ["import", "require"],
  ["development", "production"],
];

/** A map too large to reason about. Nothing is healed inside it, and the run is told why. */
export const ROW_BUDGET = 4096;
class TooComplex extends Error {}

/**
 * What is left of the budget, shared by the whole walk.
 *
 * It has to be shared because a nested object is flattened into a FRESH array whose rows are then
 * moved into the caller's: a per-array length test therefore measures one subtree and never the
 * total, so the budget it enforces is no budget at all. Measured before this counter existed: a map
 * nesting two independent conditions at each of 20 levels produced 1,048,576 rows and a 2.6 GB heap
 * without ever being refused, and the next level up is an out-of-memory crash instead of a report.
 *
 * Both growth axes are charged against it. Rows are the output; `pending` is the frontier of
 * conjunctions that have fallen through every key so far, and it doubles at each independent
 * condition whose branch can MISS — so it can hold the memory long before a single row is emitted.
 */
interface Budget {
  left: number;
}

function spend(budget: Budget, count = 1): void {
  budget.left -= count;
  if (budget.left < 0) throw new TooComplex();
}

function bind(base: Literals, name: string, value: boolean): Literals | null {
  const existing = base.get(name);
  if (existing !== undefined) return existing === value ? base : null;
  const next = new Map(base);
  next.set(name, value);
  if (!value) return next;
  for (const [left, right] of EXCLUSIVE) {
    const other = left === name ? right : right === name ? left : null;
    if (other === null) continue;
    if (next.get(other) === true) return null;
    next.set(other, false);
  }
  return next;
}

/**
 * A fallback array becomes one opaque target keyed by its own text, so it compares equal only to
 * an identical array. That is what makes this tool's refusal to rewrite arrays automatic rather
 * than a rule somebody has to remember: the runtimes disagree about them — Bun fails on
 * `[null, "./b.js"]` and `["not-relative", "./b.js"]` where Node and Deno resolve — so a proof
 * written against Node's array semantics would be quietly wrong for exactly the packages that
 * need the most care.
 */
function flatten(node: unknown, under: Literals, out: Row[], budget: Budget): void {
  if (node === null) {
    spend(budget);
    out.push({ literals: under, target: { kind: "blocked" } });
    return;
  }
  if (typeof node === "string") {
    spend(budget);
    out.push({ literals: under, target: { kind: "file", file: node } });
    return;
  }
  if (Array.isArray(node)) {
    spend(budget);
    out.push({ literals: under, target: { kind: "opaque", key: JSON.stringify(node) } });
    return;
  }
  if (!isObject(node)) {
    spend(budget);
    // A number or boolean here is an invalid target. `reviewDeclaredFiles` refuses it with the
    // message that names the offending value; this walker only has to not claim it resolves.
    out.push({ literals: under, target: { kind: "miss" } });
    return;
  }

  // `pending` holds the conjunctions that have fallen through every key so far. A branch whose
  // own resolution MISSES rejoins them, which is how Node's nested fall-through works: an object
  // that resolves nothing lets the next sibling key be tried.
  let pending: Literals[] = [under];
  for (const [key, value] of Object.entries(node)) {
    const next: Literals[] = [];
    for (const context of pending) {
      const taken = key === "default" ? context : bind(context, key, true);
      if (taken) {
        const sub: Row[] = [];
        flatten(value, taken, sub, budget);
        for (const row of sub) {
          if (row.target.kind === "miss") next.push(row.literals);
          else out.push(row);
        }
      }
      if (key !== "default") {
        const skipped = bind(context, key, false);
        if (skipped) next.push(skipped);
      }
    }
    // The frontier is charged for what it GREW BY, which is the second growth axis and the one no
    // row count can see: a branch that misses produces no output row, it rejoins `pending` to be
    // tried against the next key. So a map whose branches all fall through doubles this list at
    // every independent condition while the row total never moves. Measured without this line, a
    // 20-level map of missing branches allocated until the process died; with it, refused in 10ms.
    if (next.length > pending.length) spend(budget, next.length - pending.length);
    pending = next;
  }
  for (const context of pending) out.push({ literals: context, target: { kind: "miss" } });
}

/** The decision list for one target node, or `null` when it exceeds `ROW_BUDGET`. */
export function rowsOf(node: unknown): Row[] | null {
  const out: Row[] = [];
  try {
    flatten(node, new Map(), out, { left: ROW_BUDGET });
  } catch (error) {
    if (error instanceof TooComplex) return null;
    throw error;
  }
  return out;
}

function satisfiable(left: Literals, right: Literals): boolean {
  for (const [name, value] of left) {
    const other = right.get(name);
    if (other !== undefined && other !== value) return false;
  }
  return true;
}

function sameTarget(left: Target, right: Target): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "file" && right.kind === "file") return left.file === right.file;
  if (left.kind === "opaque" && right.kind === "opaque") return left.key === right.key;
  return true;
}

/**
 * True when two condition maps resolve identically for every possible set of active conditions.
 *
 * This is proved standalone, with every name free, which is STRICTLY STRONGER than what the
 * surrounding map needs: a nested object is always evaluated under conditions its parent has
 * already bound. Proving the stronger claim can only refuse a rewrite that would have been safe,
 * never allow one that is not — and refusing a safe rewrite costs nothing, because preserving
 * semantics beats saving bytes.
 *
 * An unprovable map (`null` rows, over budget) answers `false`, so the caller leaves it alone.
 */
export function equivalent(before: unknown, after: unknown): boolean {
  const rowsBefore = rowsOf(before);
  const rowsAfter = rowsOf(after);
  if (!rowsBefore || !rowsAfter) return false;
  for (const left of rowsBefore)
    for (const right of rowsAfter)
      if (satisfiable(left.literals, right.literals) && !sameTarget(left.target, right.target))
        return false;
  return true;
}

/**
 * Every measured consumer activates exactly one of `import` and `require`, so a row that denies
 * both describes nobody. Without this filter the commonest shape in the ecosystem —
 * `{"import": …, "require": …}` — would be reported as unreachable for a consumer that does not
 * exist, and a check that fires on a correct package is worse than no check.
 *
 * This is the ONLY predicate here that depends on what a consumer activates, and it reads one
 * binary fact rather than any runtime's condition list — so measuring further runtimes cannot move
 * it. Were the fact ever false, the cost is a SUPPRESSED warning, never a refused publish: it can
 * only silence `exports-unresolvable`, which is a `waste` finding and never aborts.
 */
export function reachableByAnyConsumer(literals: Literals): boolean {
  return !(literals.get("import") === false && literals.get("require") === false);
}
