# Contributing

`publish-clean` is a small publication-safety CLI. Keep changes narrow,
artifact-oriented, and easy to falsify.

## Local checks

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` must pass before a change is complete. It formats, typechecks,
tests under Vitest and Bun, builds, rejects tracked `dist/`, runs `publint`, and
runs `@arethetypeswrong/cli --pack .`.

## Design rules

- Keep runtime dependencies at zero.
- Use `pnpm pack` as the package artifact source of truth.
- Validate the packed artifact, not only the repository tree.
- Preserve the source tree; sanitize only the extracted publish copy.
- Do not add broad release-management features. Versioning, changelogs, tags,
  GitHub Releases, and dist-tag policy belong to release tools.
- Do not add source content rewriting such as doc or comment cleanup.
- Do not weaken critical leak checks.
- Do not track `dist/`.

## Workflows

Run this before committing workflow changes:

```bash
actions-up --yes
```

Use focused Conventional Commits with enough body context to explain why the
change exists.

## Conduct

Keep discussions technical, concrete, and respectful. Security issues belong in
private vulnerability reporting, not public issues.
