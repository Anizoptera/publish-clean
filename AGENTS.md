# @anizoptera/publish-clean

- Keep this CLI dependency-free at runtime.
- Use `pnpm pack` as the source of truth for package file selection and workspace/catalog resolution.
  Never swap it for `bun pm pack` on the grounds that this repo runs on Bun. Measured against pnpm 11.21,
  bun 1.3.14 and npm 11.19: file selection, file modes and `files` patterns are identical across all three,
  so they decide nothing. pnpm resolves from the packing package's OWN `node_modules`, so it also packs a Bun
  workspace (Bun gives each package its own) while Yarn needs a `pnpm-workspace.yaml` and one `pnpm install`
  first, because Yarn hoists to the root; bun reads `bun.lock` and refuses whatever it did not install. Bun
  additionally mangles an aliased workspace dep (`workspace:<name>@<range>`) into an invalid npm spec and
  exits 0, and pnpm alone applies `publishConfig` field overrides. npm never adopted `workspace:` at all
  and packs it verbatim, also exiting 0.
- The price of pnpm is `bundleDependencies`: a symlinked store has nothing to copy, so pnpm refuses such a
  package outright, standalone or not. The refusal is loud and names the fix (`nodeLinker: hoisted`). Do
  not answer it by switching packers, which forfeits everything above.
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
- Every guard reads the tarball that gets uploaded — its `tar` listing, or the directory extracted
  from it. Never validate an intermediate: a check against the extracted _source_ tarball, or a
  directory the tool wrote itself, proves things about bytes nobody receives and needs a second
  check to confirm the first still applies. One artifact, checked once, is why the guards here are
  short.
- Never weaken critical artifact checks for secrets, `node_modules`, Git internals, or broken export paths.
- The published package carries what consumers and the registry read, and nothing else. Dangerous content
  and useless content are both targets: a shipped tool-config block is noise every installer downloads
  forever. The manifest is the ONLY surface authorised for this — file selection belongs to `pnpm pack`,
  and no other file's contents are ever altered. Unrecognised fields ship and are reported, never dropped
  silently: dropping a key some consumer resolves breaks a stranger's build with no signal here.
- Do not add package-manager-specific behavior unless tests prove the published tarball invariant.
- Split CLI args at `--` before parsing; everything after it belongs to `npm publish`.
- Keep npm publication in `.github/workflows/release.yml`; npm trusted publishing is keyed by workflow filename.
- The publish job holds the npm credential and the OIDC identity, so it only builds, publishes, attests, and attaches. Never run `bun run check` there: Check already ran it on the same commit without credentials, and re-running it executes the test suite — which puts fake executables on `PATH` and runs fixture lifecycle scripts — beside a live token. It also behaves differently, because `id-token: write` defines `ACTIONS_ID_TOKEN_REQUEST_URL` and the CLI treats that as a trusted-publish context.
- Every release step must survive a re-run, because a run that publishes and then fails is otherwise unrepairable. Only the npm publish refuses; skip it when the version is already on the registry and let the remaining steps run.
- Generated files must not gate a release. `CHANGELOG.md` is release-please's output and is excluded from the formatter; styling it would fail the lane on every release commit.
- Publish commands must pass `--tag latest` explicitly unless intentionally proving another npm dist-tag.
- Use `--provenance` for public npmjs.com releases; trusted publishing requires Node.js 22.14.0+ and npm 11.5.1+.
- The primary pre-publish self-application check is the freshly built `dist/cli.js` against its cleaned artifact.
- After npm publication, registry-install smoke checks may update this repo to the published package and regenerate the lockfile, but they do not replace the built-current CLI gate.
- A change anyone outside this repository can observe MUST be committed as `fix` or `feat`, however
  internal the edit looks. release-please cuts a release from those two types alone, so the same change
  typed `refactor` or `chore` ships with no version of its own, or never ships at all.
- The converse binds equally: a change nobody outside can observe MUST NOT be typed `feat`, `fix`, `perf`
  or `refactor`. Those four are this repo's published changelog sections and release-please keys sections
  on TYPE alone, so a scope hides nothing — `perf(test)` and `fix(test)` land in a public release note
  beside real user-facing work. Type test and tooling work `test:`, `chore:`, `ci:` or `docs:`, which are
  omitted. Also avoid landing a defect and its fix in one unreleased range under `fix:`: both entries
  publish, they read as cancelling, and they describe a bug no released version ever had. Needing to
  hand-curate a changelog before release is the symptom of either mistake.
- Run `bun run check` before committing.
