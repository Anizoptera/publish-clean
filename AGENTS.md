# @anizoptera/publish-clean

- Keep this CLI dependency-free at runtime.
- Use `pnpm pack` as the source of truth for file selection, workspace/catalog resolution and
  `publishConfig` overrides; NEVER substitute `bun pm pack` or `npm pack`. The evidence belongs
  in `docs/why-pnpm-and-npm.md`; update it and this bullet together. A hoisted linker can enable
  pnpm bundling, but this tool still refuses bundled `node_modules`; changing packers or linkers
  does not waive that policy.
- Pack exactly ONCE. The published artifact is pnpm's tarball with its `package/package.json` member
  rewritten in place (`src/tarball.ts`), never a repack of the cleaned directory. Packing again hands
  the file set to a second packer that re-derives it from `files` — the very field being stripped — so
  it falls back to `.gitignore`/`.npmignore` and silently drops entries pnpm selected. Rewriting also
  inherits pnpm's normalisation (uid/gid 0, fixed mtime and file modes) that a plain `tar` invocation
  replaces with the build machine's own identity. Do not reintroduce a second pack to "validate" the
  output; validate the rewritten bytes instead.
- Use `npm publish <tarball>` for registry upload. It uploads those bytes verbatim
  (`pacote`'s FileFetcher streams the file), and provenance signs their sha512
  (`libnpmpublish` builds the attestation subject from `ssri.fromData(tarballData)`), so the
  attestation covers exactly what this tool produced. Publishing a tarball also runs no lifecycle
  scripts at all — `libnpmpack` gates `prepack`/`postpack` on a directory spec.
- Every guard reads the tarball that gets uploaded, decoded from the file on disk after it is
  written. Never validate an intermediate: a check against the source tarball, the in-memory value
  that produced the artifact, or a directory the tool wrote itself, proves things about bytes
  nobody receives and needs a second check to confirm the first still applies. One artifact,
  checked once, is why the guards here are short.
- `src/tarball.ts` is the ONLY reader and writer of archive bytes. Do not reintroduce the `tar`
  binary: it was a required tool on every user's machine and one spawn plus one decompression per
  question asked, for a job this file already does — and it answers in lines, so it cannot express
  a filename containing one. Tests may use it freely, and one case pins this reader against it on a
  real pnpm archive; that cross-check is the reason a hand-written parser is acceptable here.
- Never weaken critical artifact checks for secrets, `node_modules`, Git internals, or broken export
  paths. They REPORT rather than throw, and that is not a weakening: `secret-file` and
  `internal-file` carry `consequence: "harm"`, which `isFatal` returns true for after reading only
  `healed`, so no flag reaches them and `--strict` has nothing to add. Reporting is what lets one
  run show a leaked key AND everything else wrong with the package; a throw showed the key alone.
  Do not "restore" the throw for safety — it buys no refusal that `harm` does not already give, and
  it costs the rest of the report.
- Never spawn with `{ shell: true }`, on any platform, however much simpler the Windows branch in
  `src/command.ts` would look. A shell space-joins the argument vector with NO escaping — Node
  runtime-deprecated it in v24 as injection (DEP0190) — and the arguments a caller writes after `--`
  go straight into the one irreversible step. Keep the Windows job in `check.yml`: it exercises
  real shims, cancellation and the artifact pipeline. Keep the hostile argument cases in
  `test/command.test.ts` too; packing a benign repository alone missed the injection hole in 0.7.0.
- One escape hatch relaxes exactly one policy. `--skip-file-check` and `--allow-suspicious` were a
  single flag until 0.6.0, so a package that legitimately declares no `files` array had to waive the
  artifact scan as well: a manifest convention and a content guard behind one switch, where nobody
  waiving the first intends the second. Splitting a shared opt-out is not a breaking change worth
  avoiding.
- Never delete a check because the new structure makes its failure "impossible". That argument is the
  new code vouching for itself, and here the structure is always the tar rewriter — the one place this
  tool authors bytes, guarding the one step nobody can take back. These checks read values the pipeline
  has already computed, so they cost nothing and no argument can beat free. Deleting one already cost a
  release: 0.4.0 shipped with no invariant on the rewriter's file set at all.
- The published package carries what consumers and the registry read, and nothing else. Dangerous content
  and useless content are both targets: a shipped tool-config block is noise every installer downloads
  forever. The manifest is the ONLY surface authorised for this — file selection belongs to `pnpm pack`,
  and no other file's contents are ever altered. Unrecognised fields ship and are reported, never dropped
  silently: dropping a key some consumer resolves breaks a stranger's build with no signal here.
- Never reorder or remove anything inside `exports` or `imports` without a proof that resolution is
  unchanged. A consumer activates many conditions at once — webpack activates six — and takes the
  first key of the package's object that is in its set, so the order written here picks the winner
  and no reorder is cosmetic. The proof is cheap because resolution reads only an object's own keys:
  `src/conditions.ts` flattens a map into a decision list — mutually exclusive rows of
  `condition literals → target` — and two maps agree iff every jointly satisfiable row pair carries
  the same target. Cost is linear in the map's STRUCTURE, so never reintroduce a proof that
  enumerates the subsets of the NAMES: the corpus holds an object with 25 of them. The measured condition
  sets, the runtimes that disagree with each other, and why Node's published array algorithm does not
  match real Node belong in `docs/exports.md`; update it and this bullet together. That proof is
  relative to a resolver and the resolvers disagree on fallback arrays — Bun fails where Node and
  Deno succeed — so never modify an object containing one. Refusing to REWRITE an array is not a
  claim that nobody resolves it: an array flattens to an `opaque` row, so `kind === "file"` is the
  wrong test for "can anybody reach this" and silently calls published packages broken. The
  flattening is pinned to real Node under real condition sets (`test/conditions.test.ts`), never to
  hand-written expectations — those restate the same reading of the spec the code has, and Node
  departs from its own published algorithm. Keep that oracle.
- Copy a condition map by spread or an explicit null-prototype loop, NEVER `Object.assign`. A
  condition may legally be named `__proto__`; `JSON.parse` keeps it as an ordinary own property and
  `Object.assign` silently drops it, which publishes a manifest missing a branch with nothing raised
  anywhere. Any fixture covering this needs that key in it.
- **Heal what can be healed safely, report everything, and abort at the END — never at the first
  defect.** The general policy for every check in this tool, including ones not written yet:
  1. REPAIR only what can be repaired without guessing, and only in the published artifact — never
     in the author's source, and never where the repair could itself damage something. A secret is
     the standing example of a defect that must NOT be repaired: stripping it hides the leak.
  2. ACCUMULATE. A check that finds a defect returns a `Finding` and keeps going, so one run tells
     an author everything wrong with their package instead of the first thing it met. Failing fast
     is a defect here, not a virtue. A thrown `PublishCleanError` is reserved for what the run
     cannot CONTINUE past — unreadable bytes, a file set too incomplete to reason about — never for
     a defect in the package being examined. Where something still throws mid-pipeline, wrap the
     section in `try`/`finally` so the findings gathered before it are still printed. The checks
     that run BEFORE the pack have no artifact to report about, so they return their reason as a
     string and `cli.ts` refuses once with all of them — never one `throw` each.
  3. ABORT at the end when anything error-severity was left unrepaired. Publishing burns a version
     number forever, so what this tool could not heal, recover or clean must stop the run.
  4. NEVER abort on a repaired defect. The artifact being published is correct.
  5. Every abrupt stop that is a judgement call carries its own opt-out, one hatch per rule (see the
     escape-hatch bullet above). A `harm` finding has none and gets none.
- **Severity and fatality are INDEPENDENT axes. Do not collapse them.** `severityOf` says how bad
  the defect is, from the defect alone — never from what this run did about it. `isFatal` says
  whether the run stops, and it is the only irreversible decision here. A repair moves the second
  and never the first: it corrected the artifact, not the author's source, so a repaired breakage
  still prints `[error]` with the repair stated as its own sentence beside it. There is no third
  severity meaning "healed", and adding one is how a reader learns to skim — a repaired breakage
  and a harmless stray file would read alike, and the source defect then survives every release.
  `--strict` raises warnings to errors and must never make a repaired finding fatal.
- Fatality is decided by irreversibility, not by how bad a message sounds: abort on an unrepaired
  finding that leaks something or breaks a consumer, and not on one that only wastes bytes. A waste
  finding that still aborts — a shipped file nothing reaches and nobody declared, a shipped
  development file — says so through `rulesAbort` on the finding itself, never through its rule
  name, so the divergence stays visible as data instead of becoming a branch somebody tidies away.
- `src/shipped.ts` mixes OPPOSITE safe directions, and one scan carries BOTH. NEVER unify them.
  The dead-file scan over-matches deliberately — a false positive only hides a report — but its
  closure also emits `import-case-mismatch`, which ABORTS, so that one finding must take its
  position from `src/lexical.ts` like the self-import scan does. Over-matching is safe for
  reachability and fabricates a refusal here: a doc comment showing an import of a shipped file
  differing only in case would refuse a correct package. The self-import
  scan STOPS a publish, so doubt must SUPPRESS: it reads comments (`{import("pkg/sub").T}` in JSDoc
  is a type a checker resolves, so stripping them loses real defects) but skips prose, generated
  text in template literals, and commented-out `require`. Decide where a specifier sits from
  `src/lexical.ts`, NEVER from the matched line; a line-shaped test refuses sound packages. Keep
  that scanner's end-of-file check — it carries no grammar, a regex holding a quote or `/*`
  desyncs it, and a file it reports untrusted MUST yield no finding. Keep it tracking `${…}`
  too: interpolation is the one construct that UNHIDES text, and without it a template nested in
  a template reads its inner TEXT as running code — parity restored by the closing backtick, so
  nothing reports a desync — which refuses correct packages from code generators, the very
  packages that write imports into templates. Evidence, the measured
  false-positive population and why the rule has no override: `docs/exports.md`.
- NEVER generalise `import-case-mismatch` to report a specifier that resolves to NOTHING, however
  obviously that reads as the same defect — the scan already computes it and deliberately discards
  it. Measured: reporting it refuses 9.1% of packages carrying `exports`, and 6.5% after excluding
  interpolated specifiers, `.node` bindings and declaration sources, all of them packages that work
  (platform-specific bindings, template literals, directory specifiers, unshipped source paths).
  The near match is not a narrowing of that rule, it is the CORROBORATION that makes it sound: a
  folded name hitting a file that really ships is independent evidence that the specifier is a
  static path to a real file. Specimens in `docs/exports.md`.
- A packed NAME that two filesystems read as one file, or that a target filesystem cannot create,
  aborts (`reviewPackedNames`, `src/packed-names.ts`). Judge names from the ARCHIVE, never from a
  directory listing: two names differing only in case cannot coexist in a directory on a folding
  filesystem, so a disk-based check measures the filesystem and reports a zero about nothing. The
  Windows half is waived by the manifest's `os` field, and the waiver is per REASON rather than per
  rule — a path component over 255 bytes fails on ext4 and APFS too, so no platform claim excuses
  it. Decide the waiver DURING the scan, never by filtering what the scan returned: one name holds
  several reasons at once, so waiving the first one found hands `os` authority over a reason it does
  not own. Doubt about `os` suppresses, because that gate exists only to prevent a fabricated refusal.
- Verification is the same pipeline minus the publish, and `verify` skips exactly ONE guard:
  `assertPublicPackage`. A package checked before it goes public must be checked by the rules it will
  actually face, so never let a second exemption in. Every check reports through `src/finding.ts`
  rather than throwing; a thrown `PublishCleanError` is for what the run cannot continue past, not for
  a defect in the package being examined.
- Do not add package-manager-specific behavior unless tests prove the published tarball invariant.
- Split CLI args at `--` before parsing; accept only the publication options in `src/options.ts`
  afterward. Reject extra operands, workspace selectors and flag-shaped values: npm reparses
  even `--tag=--workspace` as a workspace option, so equals-form alone does not bind a value.
- Keep npm publication in `.github/workflows/release.yml`; npm trusted publishing is keyed by workflow filename.
- Release must wait for every check on its tagged commit. `verify` calls the local
  `check.yml` with no token permissions; `publish` requires its success and owns the
  publishing credentials. Keep Linux checks, dependency audit and Windows checks in that
  shared workflow, so a standalone green job cannot hide another platform's failure.
  Tests run fixture scripts and fake executables: never grant them `id-token: write`, which
  also changes CLI behavior through `ACTIONS_ID_TOKEN_REQUEST_URL`. Local `preversion` is
  fast feedback, not publication authority. Keep caller and callee concurrency groups distinct.
- Every release step must survive a re-run, because a run that publishes and then fails is otherwise unrepairable. Only the npm publish refuses; skip it when the version is already on the registry and let the remaining steps run.
- `CHANGELOG.md` is excluded from the formatter. `git-cliff` writes sections into it, and a formatter that reflows generated output turns every release into a lane failure.
- The npm dist-tag is derived from the tag, never hardcoded: a version with a prerelease
  component publishes as `next`, everything else as `latest`. A bare `npm install` resolves
  `latest`, so a hardcoded one hands every consumer the next release candidate the moment
  someone runs `bun run release prerelease`. Pass an explicit `--tag` only to prove another one.
- Use `--provenance` for public npmjs.com releases; trusted publishing requires Node.js 22.14.0+ and npm 11.5.1+.
- The primary pre-publish self-application check is the freshly built `dist/cli.js` against its cleaned artifact.
- After npm publication, registry-install smoke checks may update this repo to the published package and regenerate the lockfile, but they do not replace the built-current CLI gate.
- Record externally important behavior changes in `CHANGELOG.md` under `Unreleased` as they land,
  including compatibility restrictions and migration instructions. This is the notes source;
  GitHub release creation and reruns must use the matching version section, never a separate draft.
- Releasing is four commands and no bot: `bun run changelog v<next>` drafts the section from the
  commits since the last tag, you EDIT it (merge the curated `Unreleased` notes into that version
  and remove the consumed section), you COMMIT it, then `bun run release <next>` and
  `git push --follow-tags`. The commit is not optional bookkeeping: the bump aborts on a
  dirty tree (`ERR_PNPM_UNCLEAN_WORKING_TREE`), so the drafted section must already be committed.
  The `version` script refuses to commit or tag when `CHANGELOG.md` has no section for the new
  version, and the workflow refuses to publish when that section is empty.
- Commit TYPE no longer decides whether a change ships — the tag does. Types only pick which
  `cliff.toml` group a subject drafts into, and every type is listed, none dropped. What still
  matters is the SUBJECT: it is the first draft of a public release note, so write it for a stranger.
- Edit the drafted section before tagging. A commit subject says what changed in the tree; a release
  note says what a consumer gets. Shipping the draft unedited is how release notes become the thin,
  contentless lists this arrangement replaced.
- Nothing computes the version — you do. Reaching 1.0.0 is a decision, never a bump, and a pre-1.0
  breaking change is a MINOR. Do not delegate this to a tool that infers it from commits: measured
  2026-08-11, `git-cliff --bumped-version` answers `v1.0.0` for a `feat!` commit on 0.4.0.
- Tags must be annotated. A lightweight `git tag v0.5.0` fails outright under `tag.gpgSign = true`
  ("fatal: no tag message?"); `bun run release` annotates, which is the reason to use it over `git tag`.
- A green suite proves nothing about a test that restates its implementation. `bun scripts/mutate.ts`
  deletes each guarded rule in turn and requires the suite to go red; `--dry-run` reports in
  milliseconds which rows still match their source, so pattern rot is loud rather than a silent
  pass. Add a row when you add a guard. Nothing runs it automatically — it is one suite run per row.
- Run `bun run check` before committing. `.githooks/pre-commit` runs it again on every commit and
  `prepare` wires `core.hooksPath`, so a fresh clone gates itself; NEVER `--no-verify`, fix the
  finding. The hook validates the WORKING TREE and must never stash to isolate the staged bytes —
  that trades a rare false green for a window in which the only copy of someone's work lives in a
  tool's private state. `hooks:check` asserts the wiring inside the lane because a gate cannot
  detect that it is the wrong gate, and it asserts the executable bit twice: on disk, which decides
  whether Git runs the hook here, and in the index, where a `100644` mode leaves the author gated
  and every clone silently ungated.
