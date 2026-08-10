# Contributing

`publish-clean` has one job: publish from a package artifact that has been checked.
Keep changes close to that.

## Local checks

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` is the required gate. It formats, typechecks, runs Vitest and
Bun tests, builds, rejects tracked `dist/`, runs `publint`, and runs
`@arethetypeswrong/cli --pack .`.

## Design rules

These are not preferences. A change that breaks one of them will be rejected however
good it looks otherwise.

- Runtime dependencies stay at zero.
- `pnpm pack` decides what is in the package. Do not add file-selection rules of our own.
- `npm publish` does the upload, because provenance lives there.
- Validate the final tarball, not just the repository tree or the cleaned directory. The
  tarball is what users get.
- Never modify the source tree. Only the extracted copy gets cleaned.
- This is not a release manager. Versions, changelogs, tags, GitHub Releases and dist-tag
  policy belong to other tools.
- No rewriting of source content, including doc or comment stripping.
- Leak checks do not get weaker. Ever.
- `dist/` is never tracked.

## Workflows

Run this before committing workflow changes:

```bash
actions-up --yes
```

Use focused Conventional Commits. Include enough body context that the next
maintainer understands why the change exists.

## Conduct

Keep it technical and concrete. Security problems go to private vulnerability reporting,
never to a public issue. See [SECURITY.md](SECURITY.md).
