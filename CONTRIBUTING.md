# Contributing

`publish-clean` has one job: publish from a checked package artifact. Keep
changes close to that.

## Local checks

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` is the required gate. It formats, typechecks, runs Vitest and
Bun tests, builds, rejects tracked `dist/`, runs `publint`, and runs
`@arethetypeswrong/cli --pack .`.

## Design rules

- Keep runtime dependencies at zero.
- Use `pnpm pack` as the package artifact source of truth.
- Use `npm publish` for the final registry upload.
- Validate the final npm tarball, not only the repository tree or cleaned
  directory.
- Preserve the source tree; sanitize only the extracted publish copy.
- Do not turn this into a release manager. Versioning, changelogs, tags, GitHub
  Releases, and dist-tag policy belong to release tools.
- Do not add source content rewriting such as doc or comment cleanup.
- Do not weaken critical leak checks.
- Do not track `dist/`.

## Workflows

Run this before committing workflow changes:

```bash
actions-up --yes
```

Use focused Conventional Commits. Include enough body context that the next
maintainer understands why the change exists.

## Conduct

Keep discussions technical, concrete, and respectful. Security issues belong in
private vulnerability reporting, not public issues.
