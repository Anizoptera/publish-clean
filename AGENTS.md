# @anizoptera/publish-clean

- Keep this CLI dependency-free at runtime.
- Use `pnpm pack` as the source of truth for package file selection and workspace/catalog resolution.
- Never weaken critical artifact checks for secrets, `node_modules`, Git internals, or broken export paths.
- Do not add package-manager-specific behavior unless tests prove the published tarball invariant.
- Split CLI args at `--` before parsing; everything after it belongs to `pnpm publish`.
- Keep npm publication in `.github/workflows/release.yml`; npm trusted publishing is keyed by workflow filename.
- After first npm publication, install this package into itself and republish a minor bump through it to prove the real published CLI path.
- Run `bun run check` before committing.
