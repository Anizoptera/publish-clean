# @anizoptera/publish-clean

Clean, validate, and publish pnpm workspace packages from the actual packed artifact.

## Why

`pnpm pack` understands pnpm workspaces and catalogs, but it leaves author-only manifest fields in the package. Generic cleanup tools can strip fields, but they may ignore the package `files` contract. This CLI combines both: pack first, validate the tarball, strip author-only metadata, then publish from the cleaned extraction.

## Usage

```json
{
  "scripts": {
    "prepublishOnly": "publish-clean --guard-only",
    "publish:clean": "publish-clean -- --access public"
  },
  "devDependencies": {
    "@anizoptera/publish-clean": "^0.1.0"
  }
}
```

```bash
publish-clean --dry-run
publish-clean --guard-only
publish-clean -- --access public
```

## Guarantees

- refuses `private: true`
- validates the source package is clean unless disabled
- requires an explicit `files` array unless disabled
- aborts on critical leaks such as `.env`, `.npmrc`, `.git`, `node_modules`, and private key files
- strips dev-only manifest fields
- preserves only consumer install lifecycle scripts
- fails on unresolved monorepo-only dependency protocols
- verifies declared export/type/bin files exist in the cleaned artifact

Critical leak checks are not bypassable.
