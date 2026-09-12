/**
 * Falsifies the decision-list proof against a direct simulation of Node's resolution algorithm.
 *
 * The two implementations share no code and answer the question in opposite directions: the
 * simulation walks one condition map for one given consumer, while `equivalent` compares two maps
 * for every consumer at once without enumerating any. Agreement between them is evidence;
 * agreement between `equivalent` and a restatement of its own flattening would be none.
 *
 * The alphabet deliberately contains both mutually exclusive pairs and a name the tool does not
 * recognise, because those are the cases where a plausible-looking implementation is wrong:
 * `{import: X, require: Y, default: X}` has a provably inert `import` key, which any rule phrased
 * as "a key is redundant when a later key repeats its target" gets backwards.
 */
import { expect, it } from "vitest";
import { equivalent } from "../src/conditions";
import { reviewExports } from "../src/exports";
import { isObject } from "../src/json";

const NAMES = ["types", "node", "browser", "import", "require", "module", "custom"] as const;
const EXCLUSIVE = [
  ["import", "require"],
  ["development", "production"],
] as const;

/** Node's PACKAGE_TARGET_RESOLVE for one consumer: first key that is `default` or active wins. */
function resolveFor(node: unknown, active: ReadonlySet<string>): string | null | undefined {
  if (node === null) return null;
  if (typeof node === "string") return node;
  if (!isObject(node)) return undefined;
  for (const [condition, value] of Object.entries(node))
    if (condition === "default" || active.has(condition)) {
      const resolved = resolveFor(value, active);
      if (resolved !== undefined) return resolved;
    }
  return undefined;
}

/** Every condition set a real consumer could hold over this alphabet. */
function consumerSets(names: readonly string[]): Set<string>[] {
  const sets: Set<string>[] = [];
  for (let mask = 0; mask < 1 << names.length; mask++) {
    const active = new Set(names.filter((_, index) => (mask >> index) & 1));
    if (EXCLUSIVE.some(([left, right]) => active.has(left) && active.has(right))) continue;
    sets.push(active);
  }
  return sets;
}

function equivalentByEnumeration(left: unknown, right: unknown): boolean {
  return consumerSets(NAMES).every(
    (active) => resolveFor(left, active) === resolveFor(right, active),
  );
}

/** Deterministic, so a failure is reproducible from the seed printed in the message. */
function generator(seed: number) {
  let state = seed;
  return (bound: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % bound;
  };
}

function randomNode(next: (bound: number) => number, depth: number): unknown {
  const choice = next(depth > 0 ? 6 : 3);
  if (choice === 0) return "./a.js";
  if (choice === 1) return "./b.js";
  if (choice === 2) return null;
  const keys = new Set<string>();
  for (let count = next(3) + 1; count > 0; count--)
    keys.add(next(5) === 0 ? "default" : (NAMES[next(NAMES.length)] ?? "node"));
  const node: Record<string, unknown> = {};
  for (const key of keys) node[key] = randomNode(next, depth - 1);
  return node;
}

it("agrees with a direct simulation of Node's resolver on every consumer", () => {
  const next = generator(20_260_911);
  for (let round = 0; round < 400; round++) {
    const left = randomNode(next, 2);
    const right = randomNode(next, 2);
    const pairs: [unknown, unknown][] = [
      [left, right],
      [left, left],
    ];
    for (const [a, b] of pairs)
      expect(equivalent(a, b), `round ${round}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(
        equivalentByEnumeration(a, b),
      );
  }
});

it("proves a key inert only when no consumer can tell the difference", () => {
  // `import` cannot be active alongside `require`, so every consumer that reaches this map either
  // takes `import` and gets X, or takes `require` and gets Y, or falls to `default` and gets X.
  // Deleting `import` changes nothing. A rule reading only the following keys says otherwise.
  expect(
    equivalent(
      { import: "./x.js", require: "./y.js", default: "./x.js" },
      {
        require: "./y.js",
        default: "./x.js",
      },
    ),
  ).toBe(true);
  expect(equivalent({ node: "./x.js", default: "./x.js" }, { default: "./x.js" })).toBe(true);
  expect(equivalent({ node: "./x.js", default: "./y.js" }, { default: "./y.js" })).toBe(false);
  // An unknown name is a free variable: removable only when both branches agree.
  expect(equivalent({ custom: "./x.js", default: "./x.js" }, { default: "./x.js" })).toBe(true);
  expect(equivalent({ custom: "./src.ts", default: "./x.js" }, { default: "./x.js" })).toBe(false);
  // `null` blocks; a miss falls through. Conflating them would lose a branch.
  expect(equivalent({ node: null, default: "./x.js" }, { default: "./x.js" })).toBe(false);
});

it("never treats a fallback array as interchangeable with anything but itself", () => {
  // Bun fails where Node and Deno resolve, so an array is opaque and compares equal only to an
  // identical array. Without this, `["./a.js"]` and `"./a.js"` would look interchangeable.
  expect(equivalent(["./a.js"], "./a.js")).toBe(false);
  expect(equivalent(["./a.js"], ["./a.js"])).toBe(true);
  expect(equivalent({ node: ["./a.js"], default: ["./a.js"] }, { default: ["./a.js"] })).toBe(true);
});

function heal(pkg: Record<string, unknown>, enabled = true) {
  const { manifest, findings } = reviewExports(pkg, { heal: enabled });
  return { findings, result: manifest, rules: findings.map((finding) => finding.rule) };
}

it("repairs only what it can prove, and proves what it repaired", () => {
  const { result, rules } = heal({
    exports: { ".": { node: "./index.js", default: "./index.js" } },
  });
  expect(rules).toContain("exports-inert-condition");
  // Both the inert key and the wrapper are gone, and the whole subpath collapsed to its target.
  expect(result.exports).toEqual({ ".": "./index.js" });
  expect(equivalentByEnumeration({ node: "./index.js", default: "./index.js" }, "./index.js")).toBe(
    true,
  );
});

it("reorders toward the canonical order only when the permutation is provably neutral", () => {
  // Both branches carry the same target, so no consumer can observe which key it matched.
  const safe = heal({ exports: { ".": { import: "./m.js", types: "./m.js" } } });
  expect(safe.rules).toContain("exports-condition-order");
  const subpath = (safe.result.exports as Record<string, unknown>)["."] as Record<string, unknown>;
  expect(Object.keys(subpath)).toEqual(["types", "import"]);

  // Hoisting `types` here would CHANGE what a checker resolves — node16 ESM activates `types`
  // and `import` at once, so it takes `./m.js` today and would take `./t.d.ts` after the move.
  // That is why types-not-first is a real defect and why this tool refuses to repair it: the
  // fix is a semantic change and only the author knows which file each consumer should get. It
  // is not fatal, because the checker reaching `./m.js` then reads the `.d.ts` beside it.
  const unsafe = heal({
    exports: { ".": { import: "./m.js", types: "./t.d.ts", default: "./m.js" } },
  });
  expect(unsafe.rules).toContain("exports-condition-order-unsafe");
  expect(
    unsafe.findings.find((f) => f.rule === "exports-condition-order-unsafe")?.consequence,
  ).toBe("waste");

  // `module` losing to the ESM entry point beside it costs a bundler the build tuned for it and
  // nothing more, so this one is reported rather than refused.
  const variant = heal({ exports: { ".": { import: "./m.mjs", module: "./m.esm.js" } } });
  expect(
    variant.findings.find((f) => f.rule === "exports-condition-order-unsafe")?.consequence,
  ).toBe("waste");

  // Losing it to `require` is the opposite: `module` is active even under `require` in every
  // measured bundler, so `require` first serves CJS where ESM was available. That one aborts.
  const bundler = heal({ exports: { ".": { require: "./c.cjs", module: "./m.js" } } });
  expect(
    bundler.findings.find((f) => f.rule === "exports-condition-order-unsafe")?.consequence,
  ).toBe("breaks");
  expect(bundler.result.exports).toEqual({ ".": { require: "./c.cjs", module: "./m.js" } });

  // A rank inversion binding no measured constraint is NOT a defect: which of `import` and
  // `node` is more specific is the author's call, and reporting it would be pure noise.
  expect(heal({ exports: { ".": { import: "./m.js", node: "./n.js" } } }).rules).not.toContain(
    "exports-condition-order-unsafe",
  );
});

it("refuses a shadowed condition only when a consumer can actually lose its target", () => {
  // Every specimen below is non-neutral to reorder, so each one reaches the ordering test rather
  // than passing through the repair above. The control at the end proves the test still bites.
  const unsafe = (exports: unknown): boolean =>
    heal({ exports } as Record<string, unknown>).rules.includes("exports-condition-order-unsafe");

  // `module` ahead of `node` is the author ranking a bundler above a runtime. Forcedness binds a
  // key against LOSING, so the forced key winning is that constraint being met, not broken. Every
  // `@aws-sdk` and `@smithy` package is built this way.
  expect(unsafe({ ".": { module: "./m.js", node: "./n.js", default: "./d.js" } })).toBe(false);

  // The winner re-dispatches on the loser, so a consumer activating both meets it inside and gets
  // the file built for it — the `@emotion/styled` shape, where the canonical order is worse.
  expect(
    unsafe({
      ".": {
        development: { "edge-light": "./d.edge.js", default: "./d.js" },
        "edge-light": "./p.edge.js",
        default: "./p.js",
      },
    }),
  ).toBe(false);

  // `browser` and `bun` carry the same file, so no consumer can observe which one it matched;
  // `import` ahead of `node` is what keeps the reorder non-neutral. The `node-fetch-native` shape.
  expect(
    unsafe({
      ".": {
        browser: "./x.js",
        bun: "./x.js",
        import: "./m.js",
        node: "./n.js",
        default: "./d.js",
      },
    }),
  ).toBe(false);

  // Control: different targets, no re-dispatch, and a forced runtime name losing. A Metro config
  // that adds `browser` to its condition names gets the browser build instead of the one built for
  // React Native — the `@azure/core-util` and `bson` shape, and still fatal.
  expect(
    unsafe({
      ".": { browser: "./b.js", "react-native": "./rn.js", default: "./d.js" },
    }),
  ).toBe(true);
});

it("keeps a condition legally named __proto__, which assignment would silently drop", () => {
  // `JSON.parse` keeps this as an ordinary own property; `Object.assign` hands it to
  // `Object.prototype`'s setter, publishing a manifest missing a branch with nothing raised.
  const parsed = JSON.parse(
    '{"exports":{".":{"__proto__":{"polluted":"./p.js"},"node":"./n.js","default":"./d.js"}}}',
  ) as Record<string, unknown>;
  const { result } = heal(parsed);
  const subpath = (result.exports as Record<string, unknown>)["."] as Record<string, unknown>;
  expect(Object.keys(subpath)).toContain("__proto__");
  expect(JSON.stringify(result)).toContain("__proto__");
  expect(Object.getPrototypeOf(subpath)).toBe(Object.prototype);
});

it("reports the branch nobody reaches and the consumer nobody serves, and never confuses them", () => {
  const dead = heal({ exports: { ".": { default: "./d.js", node: "./never.js" } } });
  expect(dead.rules).toContain("exports-unreachable-branch");
  expect(dead.findings[0]?.message).toContain("./never.js");

  const hole = heal({ exports: { ".": { node: "./n.js", browser: "./b.js" } } });
  expect(hole.rules).toContain("exports-unresolvable");
  // A warning, because it fires on a quarter of published packages and most of those chose the
  // shape: a types-only package resolves nothing at run time on purpose. `--strict` promotes it.
  expect(hole.findings.find((f) => f.rule === "exports-unresolvable")?.consequence).toBe("waste");

  // A target inside a fallback array is unanalysed, never dead. Reporting those was this rule's
  // entire measured population before the fix: `acorn` and `escalade` wrap their whole entry
  // point in an array, and every target they declare was called unreachable.
  const wrapped = heal({
    exports: { ".": [{ import: "./m.mjs", require: "./c.js" }, "./c.js"] },
  });
  expect(wrapped.rules).not.toContain("exports-unreachable-branch");

  // The commonest shape in the ecosystem must not be reported: every consumer activates exactly
  // one of import/require, so the row denying both describes nobody.
  const dual = heal({ exports: { ".": { import: "./m.js", require: "./c.cjs" } } });
  expect(dual.rules).not.toContain("exports-unresolvable");
  expect(dual.rules).not.toContain("exports-unreachable-branch");
});

it("withholds the rewrite under --no-heal without withholding the finding", () => {
  const { result, findings } = heal(
    { exports: { ".": { node: "./index.js", default: "./index.js" } } },
    false,
  );
  expect(result.exports).toEqual({ ".": { node: "./index.js", default: "./index.js" } });
  expect(findings.map((f) => f.rule)).toContain("exports-inert-condition");
  expect(findings.every((f) => !f.healed)).toBe(true);
});

it("freezes every sibling of a fallback array, not only the array itself", () => {
  // The proof is relative to a resolver and the resolvers disagree about arrays, so an
  // otherwise provably inert key inside the same object still may not be removed.
  const { result, rules } = heal({
    exports: { ".": { node: "./x.js", default: "./x.js", browser: ["./a.js", "./b.js"] } },
  });
  expect(rules).toContain("exports-fallback-array");
  expect(rules).not.toContain("exports-inert-condition");
  expect(result.exports).toEqual({
    ".": { node: "./x.js", default: "./x.js", browser: ["./a.js", "./b.js"] },
  });
});

it("names a condition no measured consumer activates, without touching it", () => {
  // Private conditions are legitimate and appear in 2.5% of published packages, so this reports
  // rather than repairs. Its value is that a TYPO cannot hide among them: `improt` and a genuine
  // private name are indistinguishable to this tool, and only the author can tell them apart.
  const unknown = heal({ exports: { ".": { "my-bundler": "./b.js", default: "./d.js" } } });
  expect(unknown.rules).toContain("exports-unknown-condition");
  expect(unknown.findings.find((f) => f.rule === "exports-unknown-condition")?.healed).toBe(false);
  // Nothing is reordered across or removed around an unknown key: a name this tool cannot rank is
  // a name whose position it cannot prove neutral.
  expect(unknown.result.exports).toEqual({ ".": { "my-bundler": "./b.js", default: "./d.js" } });

  // The control: every name the tool does rank must stay silent, or the report is noise on
  // ordinary manifests rather than a signal about an unrecognised one.
  expect(
    heal({ exports: { ".": { types: "./d.ts", import: "./m.js", require: "./c.js" } } }).rules,
  ).not.toContain("exports-unknown-condition");
});

it("unwraps an object whose only key is default", () => {
  // `{"default": X}` resolves exactly as X for every consumer, so the wrapper is bytes that teach
  // nobody anything. It heals, which means this case asserts what SHIPS, not just what is said.
  const wrapped = heal({ exports: { ".": { default: "./index.js" } } });
  expect(wrapped.rules).toContain("exports-redundant-default");
  expect(wrapped.findings.find((f) => f.rule === "exports-redundant-default")?.healed).toBe(true);
  expect(wrapped.result.exports).toEqual({ ".": "./index.js" });

  // A repair withheld is still reported, and the manifest must come through untouched — the two
  // halves are separable and a flag that silenced the finding too would hide a real defect.
  const held = heal({ exports: { ".": { default: "./index.js" } } }, false);
  expect(held.rules).toContain("exports-redundant-default");
  expect(held.result.exports).toEqual({ ".": { default: "./index.js" } });

  // The control: a sibling makes the wrapper load-bearing, so unwrapping would drop a branch.
  expect(heal({ exports: { ".": { node: "./n.js", default: "./d.js" } } }).result.exports).toEqual({
    ".": { node: "./n.js", default: "./d.js" },
  });
});

it("publishes a map it cannot enumerate exactly as written", () => {
  // Beyond the row budget the equivalence proof is unavailable, and this tool's whole licence to
  // rewrite is that proof. So the map must come through byte-identical — including the inert key
  // and the misordering it would otherwise have repaired, which is what makes this case falsifying
  // rather than a restatement of the budget.
  // Both branches recurse, so each level's independent condition DOUBLES the outcomes while the
  // object graph stays linear in depth. 13 levels is 8192 rows against a 4096 budget — the cheapest
  // input that exceeds it, and small enough that the case costs milliseconds.
  let left: unknown = "./a.js";
  let right: unknown = "./b.js";
  for (let level = 0; level < 13; level++) {
    const [a, b] = [left, right];
    left = { [`vendor-${level}`]: a, default: b };
    right = { [`vendor-${level}`]: b, default: a };
  }
  const nested = left as Record<string, unknown>;
  const original = structuredClone(nested);

  const huge = heal({ exports: { ".": nested } });
  expect(huge.rules).toContain("exports-too-complex");
  expect(huge.result.exports).toEqual({ ".": original });
  expect(huge.rules).not.toContain("exports-inert-condition");

  // The control, one nesting level shallower than whatever the budget allows: a map the tool CAN
  // enumerate is repaired, so the silence above measures the budget and not a broken reviewer.
  expect(heal({ exports: { ".": { node: "./d.js", default: "./d.js" } } }).rules).toContain(
    "exports-inert-condition",
  );
});
