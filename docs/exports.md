# What may be rewritten in `exports`

Reordering two condition keys changes which file a consumer gets, so nothing in an
`exports` map may be reordered or removed without a proof that resolution is unchanged.

The manifest is the only surface this tool rewrites, and `exports` is the field on it
where a silent mistake costs a stranger a broken build with no signal here. This file
records why the obvious simplifications are not safe, and which measurements a change to
the walker in `src/declared.ts` has to keep satisfying.

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

**Only CONDITION keys are ordered. The subpath keys around them are not**, and the natural mistake
is to assume both maps behave alike. Node matches a subpath pattern by longest base first
(`PATTERN_KEY_COMPARE`), so `"./*"` written above `"./feature/*"` still loses to it. Reporting
subpath key order, or tidying it, would be pure noise — and reordering them cannot even change
resolution, so nothing here would catch the mistake.

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

## Two axes: how bad it is, and whether the run stops

Publishing burns a version number forever. Blocking a good publish costs the author a re-run;
shipping a broken package costs a release nobody can take back. So the stop decision follows that
asymmetry, not how loud a message is:

> Stop iff a finding is unhealed **and** a consumer would be harmed or broken by it.

Three consequence classes, because they need opposite responses:

| class | examples | stop if unhealed | rewrite it |
| --- | --- | --- | --- |
| harm | secret, `node_modules`, Git internals, entry outside `package/` | always | **never** — stripping a leaked token hides that it leaked, and the author still has to rotate it |
| breaks | target missing from the tarball, wrong-case target, unexported self-import | yes | only with proof |
| waste | dead files, redundant condition, unknown condition | only under `--strict`, or when the rule carries `rulesAbort` | when provable |

A healed finding never stops the run. That is not in tension with the rule above: it governs
unhealed findings, and the two cover different cases.

One waste finding stops the run anyway — a shipped file nothing in the package reaches and the
author has not declared. It is carried on the finding as `rulesAbort`, not as a special case on
the rule name, so the single divergence is data the table shows rather than a branch someone
deletes while tidying. `--strict` promotes the remaining waste findings to fatal and can never
promote a healed one.

The severity a report prints — `[error]` or `[warning]` — is the OTHER axis, and it is read off
the defect alone. Repairing one does not soften it: the defect is still in the author's source and
only the published artifact was corrected, so a repaired breakage prints `[error]` with the repair
stated beside it in words. There is deliberately no third severity meaning "healed". One existed,
and it made a repaired breakage and a harmless stray file read alike, which teaches the reader to
skim both — so the source defect survives every release while every release looks clean.

## Defects only the final tarball can show

These are the reason this tool exists. A linter reading a source directory cannot see any of them,
because each is a property of the archive or of how a consumer's machine differs from the author's.
Measured 2026-09-11 on macOS with Node 24.20.0, each case beside a control:

- **A target that differs from its tarball entry only by case.** `./dist/Index.js` resolved
  against `dist/index.js` on macOS; a genuinely absent file threw `ERR_MODULE_NOT_FOUND`. The
  author's filesystem hides it and a case-sensitive one does not — observed on a case-sensitive
  APFS volume, where `Index.js` stopped resolving — so compare byte-exact against the tar entry.
- **The same for Unicode normalisation.** A target written NFD resolved against a file stored NFC.
  `readdir` returned only the NFC form, so a byte comparison catches it and nothing else does.
  Case-sensitivity is not the discriminator for both. Probed on exFAT, default APFS and a
  case-sensitive APFS volume: only the case-sensitive one refused the wrong case, and all three
  still resolved the NFD target. Do not read that as "form never matters" — every volume here is
  mounted by macOS, which may normalise in its VFS rather than per filesystem, so this instrument
  cannot attribute the behaviour, and a filesystem normalising nothing is unmeasured. Report
  neither difference as failing on a named platform; a byte comparison is the only sound test.
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

  Both rules ask where a specifier SITS, which is why `src/lexical.ts` answers it by scanning the
  file rather than by reading the matched line. A line-shaped test gets three real shapes wrong —
  a block comment whose line does not open it, a template literal spanning lines, a trailing `//`
  after code — and each one is a refused publish over a package that is fine. The scanner carries
  no grammar, so a regular expression holding a quote or the bytes `/*` can desync it; that shows
  up as a string or block comment still open at the end of a file, which valid JavaScript cannot
  produce, and such a file is dropped entirely.

  Two further distinctions the corpus forced, each one a false positive without it. A subpath
  exposed through a fallback array IS exposed: this tool refuses to rewrite an array because the
  resolvers disagree about them, and that is not a claim that nobody resolves it. `yargs` and
  `generator-function` both publish their root that way. And only `import(…)` is load-bearing
  inside a comment — a commented-out `require(…)` is dead code no checker resolves, which is how
  `yargs` documents its own usage.

  This rule has NO override, and that is a consequence of what an override would carry rather than
  of how confident the check is. `allowUnreferenced` exists because an author knows something the
  tool cannot — a file loaded by path at run time is reachable and looks dead. Here there is no such
  knowledge to carry: an unexported subpath resolves for nobody, so an author cannot know better,
  only fix it, and the message prints the line that does. A flag would therefore exist solely to
  publish a package the author has been told is broken. Both measured hits are real defects that
  shipped, and both would have shipped again behind one.

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

  The check does NOT read `engines.node`, and that is measured rather than lazy. Gating on the
  declared range would only matter for a package promising a floor at or above `^20.19.0 ||
  >=22.12.0`; of the 662 packages with `exports` in the local corpus, 8 have a `require` branch
  resolving to ESM and every one of them declares no `engines.node` at all. A package that promises
  nothing is installable on a Node where this throws, so refusing is right for the whole measured
  population, and a semver range parser in a dependency-free CLI would change no verdict. Revisit
  if a package ever declares that floor and is refused.

## Checks that were measured and dropped

An unexecutable `bin` file in the tarball looked like an obvious defect. It is not: installed with
bun, a `0644` member came out `0755` and ran; pnpm 11 does the same. Installers have to restore the
bit because Windows-authored tarballs routinely lack it. npm cannot fail to, by construction:
`bin-links` 6.0.2 `lib/fix-bin.js` is `chmod(file, 0o777 & ~umask)` with no test of the archive's
mode, reached from both `link-bin.js` and `shim-bin.js`, so every platform takes it.

What retires the check is upstream of every installer: this tool's artifact cannot carry an
unexecutable `bin` member, because the one packer that produces it sets the mode from the file's
ROLE and ignores the mode on disk. Measured, pnpm 11.21.0 packing a package whose three members
were written at 644, 644 and 755: the `bin` target came out `0755` from a 644 source, a plain file
stayed `0644`, and a shell script authored 755 came out `0644`. So the check would read a value
that is `0755` by construction — and the remaining installer question is moot for this tool, since
no tarball it writes can pose it. The last clause is what to re-run if the packer ever changes:
pack a `bin` target authored 644 and read the member's mode, not the installed file's.

That normalisation has a consequence worth knowing and NOT worth healing: a shell script shipped in
a package loses its executable bit unless it is a `bin` target. Nothing here can repair it — the
manifest is the only surface this tool may alter — and it is pnpm's behaviour for every package
published with it, not a defect in any one of them.

Reporting a relative import that resolves to NOTHING looks like the obvious generalisation of the
case-mismatch rule, and it is the one thing in this area that must not be built. The scan already
computes it: the same guard that finds a near match first establishes that the specifier selects no
shipped file. Reporting that directly refuses 135 of 1482 packages with `exports` — 9.1%, 4239
imports — and the hits are packages that work. Excluding interpolated specifiers, `.node` bindings
and declaration sources still leaves 97 packages, 6.5%, and the remainder does not converge:

- `rolldown` names a `.node` binding per platform and ships one; `@napi-rs/lzma` and `oxlint` name a
  `.wasi.cjs` fallback the same way.
- `@loaderkit/resolve` and `lightningcss` write `"../${link}"` — a template literal, where the
  pattern captures a fragment of an expression that was never a path.
- `vitest` and `three` import `"./"` and `"../"`, directory forms that resolve to a package root.
- `vite` ships dist chunks naming `../../../src/node/constants.ts`, a source path it does not pack.

The lesson is about what the near match is FOR. It is not a narrowing of the rule, it is the
CORROBORATION that makes it sound: a folded name hitting a file that really ships is independent
evidence that the specifier is a static path to a file that exists. "Resolves to nothing" never
establishes that, because the scanner is a pattern over source with an approximate resolver, and
every class above is a case where the specifier was not what it looked like. A rule without that
corroboration fires on packages that work, which is the same reason the browser-field rule below
was dropped.

The legacy `browser` FIELD contradicting an `exports` browser target is publint's
`EXPORTS_VALUE_CONFLICTS_WITH_BROWSER`, and it is real: a bundler honouring the field substitutes a
file `exports` never chose, with nothing raised anywhere. Measured over 3490 installed packages,
resolving through this tool's own row engine: 34 carry both mechanisms, and exactly 2 distinct
packages disagree — `css-tree` (four versions) and `@napi-rs/lzma`. Both are deliberate: the field
sends field-reading bundlers to a prebuilt browser bundle while `exports` hands source to
condition-reading ones. A rule here would fire on packages that work, which is the same reason the
name-based dead-directory rule was dropped.

Two traps for whoever re-measures. A condition set holding BOTH `import` and `require` matches no
row at all — sibling-key exclusivity is encoded in the rows — so it silently reports zero. And
comparing the browser condition's target against a remap of the NODE target pits an ESM path
against a CJS one, which makes `nanoid`, `uuid` and `clipanion` look like conflicts; the sound test
is whether the field remaps the very file the browser condition resolved to.

Recorded because the next person will have the same idea, and re-deriving the answer costs an
afternoon.

## How often each rule fires

Measured over the local corpus of packages with an `exports` field, per package, so one manifest
with 200 subpaths counts once. The corpus is this machine's dependency closure rather than the
registry, so it over-represents modern tooling — read these as the order of magnitude that justifies
a rule existing, not as registry shares.

| shape | packages |
| --- | --- |
| `types` not first among its siblings | 6.1% |
| a condition provably inert | 5.9% |
| unknown or private condition present | 2.5% |
| no root `.` entry | 2.6% |
| fallback array used | 2.1% |
| `{"default": X}` collapsible | 1.5% |
| deprecated trailing-slash key | 0.6% |
| `default` not last | 0.1% |
| `module` after `require` | one package |
| relative import resolving only after folding case or Unicode form | none |
| two packed names differing only in case or Unicode form | none |
| a packed name a target filesystem cannot create | none |

The last three rows are not reasons to drop those rules, and the distinction decides whether any
check here is worth its bytes. The rows above them are candidate rules judged on how often they
would fire, which is the right question for a rule that only saves bytes. The last three describe
defects that cannot be taken back, so what decides them is whether they can fire WRONGLY, and none
of them can: two names that fold together do become one file, a name Windows refuses is refused,
and the case-mismatch rule fires only when a folded name hits a file that really ships.

The first of the three also describes a shape the tool ALREADY reacted to and reacted wrongly: the
target went unreached, so the dead-weight rule called it unreachable and advised deleting a file the
code imports. Its measurement — 300 packages, 21451 relative specifiers, sampled evenly across the
corpus, verified against a planted positive so the zero is not an unexercised branch — bounds how
often an author meets it, not whether the advice they get should be correct. The other two were
measured over 319 published tarballs (15844 members) and, for the unportable one, another 3490
installed packages (187187 files). Installed directories cannot measure a COLLISION at all: two
names differing only in case cannot coexist in a directory on a folding filesystem, so a zero from
them describes the filesystem rather than any package. Tarball members have no such limit, which is
what makes them the instrument for it.

Two things follow. Every waste rule here fires on single-digit percentages, so none of them can
justify risk — which is why each is gated by the equivalence proof rather than by a style argument.
And dropping a redundant condition saves roughly thirty bytes: the manifest is not where the waste
is, the shipped files are, by three orders of magnitude.

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

What the edge runtimes activate when they DO run is not measured here, and neither is Vite's SSR
profile — only the consumers in the table were. So the rule putting a named runtime ahead of `node`
generalises the one case that was measured, Bun and Deno activating `node`, to every runtime in the
registry. That generalisation can only ever produce ADVICE: `src/exports.ts` reorders nothing it
cannot prove neutral, so a tier claim that turns out too broad costs a suggestion, never a consumer.
Measure a runtime's own set before treating its row as fact.

## Node's published algorithm is wrong about fallback arrays

`PACKAGE_TARGET_RESOLVE` as documented stops at the first non-`undefined` result. Real
Node skips `null` and invalid entries and continues. The comment in `src/declared.ts`
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

## Writing a map that resolves everywhere

Environment (where it runs), module system (how it is loaded) and mode (dev or prod) are three
INDEPENDENT axes. Flattening them into one ordered list forces precedence decisions nobody gets
right, because the list cannot express that two keys answer different questions. Nest them and most
ordering questions stop existing:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "bun":     { "import": "./dist/index.js",   "require": "./dist/index.cjs" },
      "browser": { "import": "./dist/browser.js", "require": "./dist/browser.cjs" },
      "node":    { "import": "./dist/node.js",    "require": "./dist/node.cjs" },
      "default": "./dist/index.js"
    }
  },
  "main": "./dist/index.cjs"
}
```

Four things that map gets right, each for a reason measured above:

- **`bun` before `node`**, because Bun and Deno both activate `node`. A specific runtime placed
  after `node` is unreachable.
- **`default` last and present.** Edge runtimes activate neither `node` nor `browser`, so a map
  without `default` hands them nothing — the failure mode that costs the most and shows up latest.
- **`types` first**, but only because one declaration file serves every branch. With separate
  `.d.mts`/`.d.cts` the correct shape is a `types` key nested INSIDE each module-system branch: the
  invariant is that the branch a type checker lands on describes the branch the runtime lands on,
  and "types first" is just the single-file case of it.
- **`main` kept**, for the consumers in the next section.

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
