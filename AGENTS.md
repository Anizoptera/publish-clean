# @anizoptera/publish-clean

- Keep this CLI dependency-free at runtime.
- Use `pnpm pack` as the source of truth for package file selection and workspace/catalog resolution.
- Never weaken critical artifact checks for secrets, `node_modules`, Git internals, or broken export paths.
- Do not add package-manager-specific behavior unless tests prove the published tarball invariant.
- Split CLI args at `--` before parsing; everything after it belongs to `pnpm publish`.
- Keep npm publication in `.github/workflows/release.yml`; npm trusted publishing is keyed by workflow filename.
- After each successful npm publication, update this repo to use the just-published package, regenerate and commit the lockfile, then publish the next bump through that installed CLI. Use the explicit `latest` tag only when it is the intended proven release channel.
- Run `bun run check` before committing.
