# Contributing

Keep changes focused on cleaning and checking the tarball that npm uploads.

## Local checks

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` is the required gate. It checks formatting, typechecks, builds, runs the
Vitest suite against that build, rejects a tracked `dist/`, asserts that Git will actually
run this repository's commit hook, and runs the
freshly built CLI on this package itself — asserting the cleaned artifact has no runtime
dependencies and passing it to `publint` and `@arethetypeswrong/cli`.

Run self-application after the CLI tests: packing this repository runs its `prepare`
script and rebuilds `dist`. Running both together races the tests against deletion and
replacement of the executable they are testing. Formatting, types and repository checks
can run in parallel because they do not write that build.

`bun install` points `core.hooksPath` at `.githooks`, so from then on every commit runs that
same gate and a failing tree cannot enter history. Fix what it reports; never pass
`--no-verify`. It validates the working tree rather than the staged snapshot, so an unrelated
broken file blocks an unrelated commit — stash it deliberately if that is what you want.

## Design rules

Follow these rules to preserve the checked artifact through publication.
See [AGENTS.md](AGENTS.md) for the reasoning and measurements.

- Runtime dependencies stay at zero.
- `pnpm pack` selects files. Do not add another file-selection mechanism.
- `npm publish` uploads the checked tarball verbatim; see `docs/why-pnpm-and-npm.md` before changing the uploader.
- Validate the tarball that gets published, and nothing else. Checking an extracted copy or
  the repository tree proves things about something no user receives.
- Cleaning must not modify the source tree; package lifecycle scripts may. Pack only once. The manifest is read out of the packed
  tarball and replaced inside that temporary file; repacking would hand
  the file set to a second packer that re-derives it from the stripped `files`.
- This is not a release manager. Versions, changelogs, tags, GitHub Releases and dist-tag
  policy belong to other tools.
- No rewriting of source content, including doc or comment stripping.
- Preserve the checks for credentials, Git internals, `node_modules` and broken entry points.
- `dist/` is never tracked.

## Commits

Use focused Conventional Commits. Explain why the change is needed in the body.

Pick the type by what a user can observe, not by how the edit looks: `feat` and `fix` for
anything a consumer can see, `test:`, `chore:`, `ci:` or `docs:` for anything they cannot.
The type does not decide whether a change ships — a pushed tag does — it decides which
changelog group the subject drafts into, and every commit is drafted. Mark a breaking
change `!`; pre-1.0 it releases as a minor.

Write the subject for a stranger. It becomes the first draft of a public release note.

## Workflows

Run this before committing workflow changes:

```bash
actions-up --yes
```

## Conduct

Keep it technical and concrete. Security problems go to private vulnerability reporting,
never to a public issue. See [SECURITY.md](SECURITY.md).
