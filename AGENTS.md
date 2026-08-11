# @anizoptera/publish-clean

- Keep this CLI dependency-free at runtime.
- Use `pnpm pack` as the source of truth for file selection and workspace/catalog resolution. NEVER swap it
  for `bun pm pack` on the grounds that this repo runs on Bun, nor for `npm pack`. File selection is
  identical across all three and decides nothing; pnpm alone resolves every workspace layout it can be
  handed, applies `publishConfig` field overrides, and refuses what it cannot resolve instead of packing it
  broken. Its one price is `bundleDependencies`, which pnpm refuses loudly while naming the fix
  (`nodeLinker: hoisted`) — do not answer that by switching packers, which forfeits the rest. Measurements,
  tool versions and the exact failure of each alternative: `docs/why-pnpm-and-npm.md`, which is also the
  README's answer to "why do I need pnpm installed". Update it and this bullet together.
- Pack exactly ONCE. The published artifact is pnpm's tarball with its `package/package.json` member
  rewritten in place (`src/tarball.ts`), never a repack of the cleaned directory. Packing again hands
  the file set to a second packer that re-derives it from `files` — the very field being stripped — so
  it falls back to `.gitignore`/`.npmignore` and silently drops entries pnpm selected. Rewriting also
  inherits pnpm's normalisation (uid/gid 0, fixed mtime, mode 644) that a plain `tar` invocation
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
- Never weaken critical artifact checks for secrets, `node_modules`, Git internals, or broken export paths.
- Never spawn with `{ shell: true }`, on any platform, however much simpler the Windows branch in
  `src/command.ts` would look. A shell space-joins the argument vector with NO escaping — Node
  runtime-deprecated it in v24 as injection (DEP0190) — and the arguments a caller writes after `--`
  go straight into the one irreversible step. The Windows job in `check.yml` is the only instrument
  that grades that branch; delete it and the platform is unsupported again, verified by nothing. It
  grades BENIGN input only — it packs this repository, whose paths hold no cmd metacharacter — which
  is exactly how a command-injection hole shipped in 0.7.0 under a green run. The hostile inputs live
  in `test/command.test.ts`, where the platform is a parameter and every OS runs them.
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
- Do not add package-manager-specific behavior unless tests prove the published tarball invariant.
- Split CLI args at `--` before parsing; everything after it belongs to `npm publish`.
- Keep npm publication in `.github/workflows/release.yml`; npm trusted publishing is keyed by workflow filename.
- Release is two jobs, and the split is what makes both true at once: `verify` runs `bun run check` on the tagged commit holding NO permissions, and `publish` declares `needs: verify` and does only what the credential is for — build, publish, attest, attach. Never merge them into one job. The suite puts fake executables on `PATH` and runs fixture lifecycle scripts, which must not happen beside a live token, and `id-token: write` defines `ACTIONS_ID_TOKEN_REQUEST_URL`, which the CLI reads as a trusted-publish context and behaves differently under. `preversion` still runs the lane locally, but as fast feedback, never as the gate: a hand-made tag or any local bypass would otherwise reach the registry, and an npm version is permanent.
- Every release step must survive a re-run, because a run that publishes and then fails is otherwise unrepairable. Only the npm publish refuses; skip it when the version is already on the registry and let the remaining steps run.
- `CHANGELOG.md` is excluded from the formatter. `git-cliff` writes sections into it, and a formatter that reflows generated output turns every release into a lane failure.
- The npm dist-tag is derived from the tag, never hardcoded: a version with a prerelease
  component publishes as `next`, everything else as `latest`. A bare `npm install` resolves
  `latest`, so a hardcoded one hands every consumer the next release candidate the moment
  someone runs `bun run release prerelease`. Pass an explicit `--tag` only to prove another one.
- Use `--provenance` for public npmjs.com releases; trusted publishing requires Node.js 22.14.0+ and npm 11.5.1+.
- The primary pre-publish self-application check is the freshly built `dist/cli.js` against its cleaned artifact.
- After npm publication, registry-install smoke checks may update this repo to the published package and regenerate the lockfile, but they do not replace the built-current CLI gate.
- Releasing is four commands and no bot: `bun run changelog v<next>` drafts the section from the
  commits since the last tag, you EDIT it, you COMMIT it, then `bun run release <next>` and
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
- Run `bun run check` before committing.
