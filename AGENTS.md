# @anizoptera/publish-clean

- Keep this CLI dependency-free at runtime.
- Use `pnpm pack` as the source of truth for package file selection and workspace/catalog resolution.
- Never weaken critical artifact checks for secrets, `node_modules`, Git internals, or broken export paths.
- Do not add package-manager-specific behavior unless tests prove the published tarball invariant.
- Run `bun run check` before committing.
