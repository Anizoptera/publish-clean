# What may be rewritten in `exports`

Reordering two condition keys changes which file a consumer gets, so nothing in an
`exports` map may be reordered or removed without a proof that resolution is unchanged.

The manifest is the only surface this tool rewrites, and `exports` is the field on it
where a silent mistake costs a stranger a broken build with no signal here. This file
records why the obvious simplifications are not safe, and which measurements a change to
the walker in `src/artifact.ts` has to keep satisfying.

Profiles below were measured on 2026-09-11 against Node 24.20.0, Bun 1.4.1, Deno 2.9.6,
TypeScript 7.0.2 and the bundler versions named; each run carried a control subpath with
no condition object, and a run whose control did not appear was discarded. They are
regression cases to rerun when evaluating another version, not universal claims.

## Why order is the whole mechanism

A consumer does not activate one condition. It activates a set — webpack activates six —
and then walks the package's object top to bottom taking the first key in that set. The
winner is chosen by the order in the package, not by any preference the consumer holds.

So there is no such thing as a cosmetic reorder here, and a rule of thumb about "correct"
ordering cannot justify one.

## The proof that does justify one

Resolution of a condition object depends only on which of its own keys are active; a
condition the object does not mention cannot change what it returns. Objects carry a
handful of names, so the possible inputs are the subsets of those names — enumerable in
full.

That makes redundancy and reorder-safety provable rather than estimated: resolve both
versions under every subset and compare. A key may be dropped, or two keys swapped, only
when every subset agrees. An unrecognised condition name enters the enumeration as a free
variable, which is sound — `{"x": "./a.js", "default": "./a.js"}` is provably removable
whatever `x` means, and `{"x": "./src/index.ts", "default": "./dist/index.js"}` is not.

Run the proof with the same resolver the rewrite uses. A separately written check and the
rewrite it authorises are two pieces of code that agree today.

## Condition sets, measured

| consumer | activates |
| --- | --- |
| Node 24.20.0 ESM | `node` `import` `module-sync` `node-addons` |
| Node 24.20.0 CJS | `node` `require` `module-sync` `node-addons` |
| Bun 1.4.1 ESM | `node` `bun` `import` `node-addons` |
| Bun 1.4.1 CJS | `node` `bun` `require` `node-addons` |
| Deno 2.9.6 ESM | `node` `deno` `import` `module-sync` |
| esbuild browser / node / neutral | `browser default import module` / `default import module node` / `default import` |
| webpack web+prod / node+dev | `browser default import module module-sync production` / `default development import module module-sync node` |
| rspack web+prod | `browser default import module production` |
| rollup + `@rollup/plugin-node-resolve` | `default import module production` |
| rolldown / vite lib / parcel 2.16.4 | `browser default import module` (vite and parcel also `production`) |
| `bun build` browser / node | `browser default development import module node-addons` / `default development import node node-addons` |
| TypeScript `node16` ESM / CJS / `bundler` | `types node import default` / `types node require default` / `types import default` |

Three consequences this tool has to encode rather than infer:

- **Bun and Deno both activate `node`.** A `node` branch is not a Node branch, and a `bun`
  key placed after `node` is unreachable.
- **`bun build` never activates `bun`.** The bundler and the runtime of one name are
  different consumers.
- **TypeScript activates none of `module`, `module-sync`, `browser`, `development`,
  `production`.** A package selected through `module` takes its declarations from a
  different branch, so "types first" is the single-declaration-file special case and not
  the invariant. The invariant is that the branch a checker lands on describes the branch
  the runtime lands on.

Nothing measured activates `types`, `deno`, `workerd`, `edge-light`, `react-server`,
`worker`, `style` or `source` by default; those depend on consumer configuration.

## Node's published algorithm is wrong about fallback arrays

`PACKAGE_TARGET_RESOLVE` as documented stops at the first non-`undefined` result. Real
Node skips `null` and invalid entries and continues. The comment in `src/artifact.ts`
saying arrays continue past `null` is correct against the runtime; the specification prose
is the thing that is wrong, so do not "fix" the walker to match the document.

Runtimes also disagree here, which is why a fallback array is reported and never
synthesised:

| case | Node 24.20.0 | Deno 2.9.6 | Bun 1.4.1 |
| --- | --- | --- | --- |
| `["./b.js"]` (control) | `b.js` | `b.js` | `b.js` |
| `[null, "./b.js"]` | `b.js` | `b.js` | fails |
| `["not-relative", "./b.js"]` | `b.js` | `b.js` | fails |

Node also accepts `@`, `>` and `=` inside a condition name, so `types@>=5.2` and stranger
keys are valid and must not be rejected as malformed.

## Not every consumer reads `exports`

Parcel 2.16.4 ignores the field unless the consuming project opts in
(`packageExports: conf?.contents?.packageExports ?? false` in
`@parcel/resolver-default/src/DefaultResolver.js`). A package shipping `exports` with no
`main` does not resolve under a stock Parcel setup, which is why stripping `main` as
redundant with `exports` is not a byte saving this tool may take.

## A file is reachable by more than an import

Before any check treats a shipped file as dead weight, note the ways a file gets used that
no import graph records, each observed in published packages: a child process spawned by
path, a native loader reading `prebuilds/`, a manifest field outside the seed list such as
`man`, a source map's `sources` array, and a data directory read with `fs`. Measured across
655 packages, flagging any file unreachable through `exports` fires on 97.1% of them.

The reachable form of the check is the one with no false positives: a path the manifest
declares that the archive does not contain. `assertDeclaredFiles` owns it.
