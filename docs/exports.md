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

Resolution of a condition object depends only on which of its own keys are active, so
flattening the map top to bottom yields a **decision list**: a sequence of rows, each one
a conjunction of `name is active` / `name is not active` literals plus the target reached
when that conjunction holds. The rows are mutually exclusive and cover every consumer
there can be, measured or not. `src/conditions.ts` owns this.

Two maps are equivalent iff every pair of rows whose conjunctions can hold together
carries the same target — and whether two conjunctions can hold together is a scan for one
name bound both ways, plus the pairs that exclude each other (`import`/`require`,
`development`/`production`). No search, no enumeration.

That makes redundancy and reorder-safety provable rather than estimated. A key may be
dropped, or two keys swapped, only when the flattened lists agree. An unrecognised
condition name is just another literal that nothing binds, which is sound in both
directions — `{"x": "./a.js", "default": "./a.js"}` is provably removable whatever `x`
means, and `{"x": "./src/index.ts", "default": "./dist/index.js"}` is not.

Enumerating the subsets of the names instead was rejected: it costs `2ⁿ` in the NAMES, and
a real package in the measured corpus carries a condition object with 25 distinct names —
33 million subsets, which forces a cap and a third "could not prove" verdict that then has
to be handled everywhere. A decision list is linear in the STRUCTURE, which is a few dozen
rows at worst, so the cap, the memo table and the third verdict all disappear.

Run the proof with the same `flatten` the rewrite runs. A separately written check and the
rewrite it authorises are two pieces of code that agree today.

## What stops a publish, and why that is not a severity question

Publishing burns a version number forever. Blocking a good publish costs the author a re-run;
shipping a broken package costs a release nobody can take back. So the stop decision follows that
asymmetry, not how loud a message is:

> Stop iff a finding is unhealed **and** a consumer would be harmed or broken by it.

Three consequence classes, because they need opposite responses:

| class | examples | stop if unhealed | rewrite it |
| --- | --- | --- | --- |
| harm | secret, `node_modules`, Git internals, entry outside `package/` | always | **never** — stripping a leaked token hides that it leaked, and the author still has to rotate it |
| breaks | target missing from the tarball, wrong-case target, unexported self-import | yes | only with proof |
| waste | dead files, redundant condition, unknown condition | never | when provable |

A healed finding never stops the run. That is not in tension with the rule above: it governs
unhealed findings, and the two cover different cases.

One waste finding stops the run anyway — a shipped file nothing in the package reaches and the
author has not declared. It is carried on the finding as `rulesAbort`, not as a special case on
the rule name, so the single divergence is data the table shows rather than a branch someone
deletes while tidying. `--strict` promotes the remaining waste findings to fatal and can never
promote a healed one.

## Defects only the final tarball can show

These are the reason this tool exists. A linter reading a source directory cannot see any of them,
because each is a property of the archive or of how a consumer's machine differs from the author's.
Measured 2026-09-11 on macOS with Node 24.20.0, each case beside a control:

- **A target that differs from its tarball entry only by case.** `./dist/Index.js` resolved
  against `dist/index.js` on macOS; a genuinely absent file threw `ERR_MODULE_NOT_FOUND`. The
  author's filesystem hides it and a case-sensitive one does not, so compare byte-exact against the
  tar entry.
- **The same for Unicode normalisation.** A target written NFD resolved against a file stored NFC.
  `readdir` returned only the NFC form, so a byte comparison catches it and nothing else does.
- **A package importing itself through an unexported subpath.** `selfref/sub.js` threw
  `ERR_PACKAGE_PATH_NOT_EXPORTED` even though the file ships and a relative import of it worked.
  Self-reference goes through `exports`, so shipping the file is not enough, and the author cannot
  see it from the source tree, where the same import resolves by path.

  Measured across 662 published packages carrying `exports`: two have one, and both are real —
  `@eslint-community/regexpp` ships an `index.d.ts` importing `<name>/ast` while exporting only
  `.`, and `highlight.js` reaches `highlight.js/private` from its declarations and its JSDoc types.
  Every hit was in the TYPE layer, none at run time. That matters for severity, and was measured on
  TypeScript 7.0.2 beside an exported control subpath: `skipLibCheck: false` gives the consumer
  `TS2307` in a file they cannot edit, and `skipLibCheck: true` — the common default — silently
  degrades the type to an error-suppressed `any`.

  Finding one without a parser needs two opposite rules, and both came from the corpus rather than
  from reasoning. Comments are READ, not stripped: `{import("pkg/sub").T}` in a JSDoc block is a
  type a checker resolves, and stripping comments loses `highlight.js` entirely. Prose inside those
  same comments is skipped: a documentation example of an import was the whole false-positive
  population, `rolldown` and `nanoid` each advertising a subpath they had removed. A specifier
  inside a template literal is skipped as text the file generates for somebody else's project
  (`@opentui/core` writes an import statement into a string). Suppression is the safe direction
  here, because unlike the dead-file scan this finding stops a publish.

  The same defect exists for `#` specifiers a package's own `imports` never declares, and it is NOT
  checked: 12 of those 662 packages use a `#` specifier at all, and the only undeclared one found
  was a code generator emitting an import for its user's project. A rule whose entire measured
  population is a false positive does not get built.
- **A `bin` shebang ending in CR.** `env: node\r: No such file or directory`; the LF control ran.
- **`require()` of an ESM file is no longer fatal by itself.** On Node 24.20.0 it resolved; it
  threw `ERR_REQUIRE_ASYNC_MODULE` only when the module used top-level await. Unflagged support is
  `^20.19.0 || >=22.12.0`, and a consumer can still opt out with
  `--no-experimental-require-module`. So the finding is: top-level await is always broken under
  `require`, and without it the breakage depends on the `engines.node` range the package claims.
  The usual fix is to add a `module-sync` branch, which exists precisely so `require` and `import`
  can load one ES module.

## A check that was measured and dropped

An unexecutable `bin` file in the tarball looked like an obvious defect. It is not: installed with
bun, a `0644` member came out `0755` and ran. Installers have to restore the bit because
Windows-authored tarballs routinely lack it. Measured on bun only — if pnpm, npm or yarn turn out
not to, this check comes back.

Recorded because the next person will have the same idea, and re-deriving the answer costs an
afternoon.

## Copying a condition map

Never copy one with `Object.assign`. A condition may legally be named `__proto__`, and `JSON.parse`
keeps it as an ordinary own property — but `Object.assign` turns it into the copy's prototype
instead. Measured: the branch disappears from `Object.keys` and from `JSON.stringify`, so the
rewritten manifest ships missing a condition, while the copy simultaneously answers to every key
that branch contained as an inherited property. Nothing is raised at any point.

`Object.prototype` is not touched, so this is not the usual prototype-pollution bug — it is silent
loss on the way out plus phantom keys on the way in. Spread round-trips it correctly, as does an
explicit null-prototype loop. Any fixture for this needs a `__proto__` key in it.

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

That 97.1% is the instrument, not the waste: README, LICENCE, declarations, source maps and
native binaries are all unreachable by an import and all tell somebody something. So
unreachability is EVIDENCE that a file may be useless, never the verdict, and `src/shipped.ts`
subtracts the categories that are unreachable by nature before reporting. What survives that is
an error the author clears with one config line the message prints
(`"publish-clean": { "allowUnreferenced": [...] }`), because a file genuinely loaded in a way no
import records — a binary a loader finds by path, a directory read at run time — must not cost
its author a publish.

The specifier scan behind it is deliberately over-inclusive: it matches inside comments and
strings, and it must, because the finding is "nothing references this file". Over-matching can
only suppress a report, never invent one — the usual objection to a regex over syntax assumes a
false negative is the safe direction, and here it is the false positive that would hurt.

Reachability is only meaningful when `exports` closes the package. Without that field every
shipped path is importable by a consumer, so nothing is dead and the check does not run.

The strictest form of the check needs none of this: a path the manifest declares that the archive
does not contain. `assertDeclaredFiles` owns it and has no false positives at all.
