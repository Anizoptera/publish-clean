# @anizoptera/publish-clean

- Keep this CLI dependency-free at runtime.
- Use `pnpm pack` as the source of truth for package file selection and workspace/catalog resolution.
- Never weaken critical artifact checks for secrets, `node_modules`, Git internals, or broken export paths.
- Do not add package-manager-specific behavior unless tests prove the published tarball invariant.
- Split CLI args at `--` before parsing; everything after it belongs to `pnpm publish`.
- Keep npm publication in `.github/workflows/release.yml`; npm trusted publishing is keyed by workflow filename.
- Publish commands must pass `--tag latest` explicitly unless intentionally proving another npm dist-tag.
- The primary pre-publish self-application check is the freshly built `dist/cli.js` against its cleaned artifact.
- After npm publication, registry-install smoke checks may update this repo to the published package and regenerate the lockfile, but they do not replace the built-current CLI gate.
- Run `bun run check` before committing.
