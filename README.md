# @anizoptera/publish-clean

Publish pnpm workspace packages from a cleaned, validated package artifact.

`publish-clean` packs the package first, inspects the exact tarball contents,
rewrites only the extracted publish copy, and publishes from that cleaned
artifact. The source tree is not rewritten.

## Why

Package publication has several independent failure modes:

- `pnpm pack` understands pnpm workspaces, catalogs, and publish-time package
  projection, but it does not remove author-only manifest fields.
- Generic cleanup tools can remove fields, but they may drift from the package
  manager's actual `files` and ignore semantics.
- Release tools can version, tag, and publish packages, but they usually do not
  prove that the final tarball is free of monorepo-only specs, critical leaks,
  or broken declared entrypoints.

`publish-clean` is deliberately narrower: use pnpm's packed artifact as the
source of truth, fail on dangerous contents, strip development-only metadata
from the extracted package, and then publish from that cleaned package.

## Install

```bash
pnpm add -D @anizoptera/publish-clean
```

Requirements:

- Node.js 20 or newer
- `pnpm` and `tar` available in `PATH`
- Bun is recommended for this repository's own checks, but the published CLI
  runs on Node.js

## Usage

Recommended package scripts:

```json
{
  "scripts": {
    "check": "bun run typecheck && bun run test && bun run build",
    "prepublishOnly": "bun run check && publish-clean --guard-only",
    "publish:clean": "bun run check && publish-clean -- --access public"
  },
  "devDependencies": {
    "@anizoptera/publish-clean": "^0.1.0"
  }
}
```

Common commands:

```bash
publish-clean --dry-run
publish-clean --guard-only
publish-clean --registry https://registry.npmjs.org -- --access public
publish-clean packages/my-lib -- --access public --tag next
```

Use `publish:clean`, `release`, or another explicit script name for real
publication. Avoid naming the script `publish`; npm lifecycle names are easy to
trigger unintentionally.

## CLI

```bash
publish-clean [options] [package-dir] [-- pnpm-publish-args]
```

Options:

- `--dry-run`: pack, extract, validate, sanitize, and print the extracted
  package path without publishing.
- `--guard-only`: run the same guard path without requiring a clean git state
  and without publishing.
- `--registry URL`: set `publishConfig.registry` on the cleaned manifest before
  publishing.
- `--skip-file-check`: skip suspicious-file checks and the required `files`
  array check; critical leak checks still run.
- `--no-git-checks`: skip the source git cleanliness check.
- `-h`, `--help`: print usage.

Arguments after `--` are passed to `pnpm publish` from the cleaned extracted
package.

## Configuration

Optional package configuration lives in `package.json`:

```json
{
  "publish-clean": {
    "registry": "https://registry.npmjs.org",
    "skipFileCheck": false,
    "noGitChecks": false,
    "devFields": ["customBuildOnlyField"]
  }
}
```

Use config only for stable project policy. Prefer CLI flags for one-off
publication choices such as dist-tags.

## Guarantees

`publish-clean`:

- refuses `private: true`
- validates the source package is clean unless disabled
- requires a non-empty `files` array unless disabled
- always rejects critical leaks such as `.env`, `.npmrc`, `.git`,
  `node_modules`, and private-key files
- rejects common suspicious publish contents unless disabled
- strips development-only manifest fields from the extracted package
- preserves only consumer install lifecycle scripts
- fails unresolved `catalog:`, `workspace:`, `link:`, and `portal:` specs
- verifies declared export, type, import, browser, bin, and side-effect paths
  exist in the cleaned artifact
- warns when invoked from a non-pnpm lifecycle because pnpm is the intended pack
  and publish source of truth

Critical leak checks are not bypassable.

## Non-goals

`publish-clean` does not manage:

- versions, changelogs, tags, commits, pushes, or GitHub Releases
- npm account setup, trusted publishing setup, OTP, or registry credentials
- package compatibility linting beyond artifact invariants
- a custom ignore language
- source documentation or comment rewriting

Use dedicated release tools for release orchestration and dedicated validators
for ecosystem compatibility.

## Prior art and boundaries

`publish-clean` is built around existing publication semantics instead of
replacing them:

- [`clean-publish`](https://github.com/shashkovdanil/clean-publish) proved the
  value of publishing from a cleaned copy. `publish-clean` keeps that shape but
  stays focused on artifact sanitation, not broad content rewriting.
- [`npm-packlist`](https://github.com/npm/npm-packlist),
  [`npm pack`](https://docs.npmjs.com/cli/v11/commands/npm-pack/), and
  [`npm publish`](https://docs.npmjs.com/cli/v11/commands/npm-publish/) define
  the baseline package-file model.
- [`pnpm pack`](https://pnpm.io/cli/pack),
  [`pnpm publish`](https://pnpm.io/cli/publish), and
  [`publishConfig`](https://pnpm.io/package_json#publishconfig) are the primary
  target because pnpm workspaces and catalogs need pnpm-aware packing.
- [`publint`](https://publint.dev/) and
  [`@arethetypeswrong/cli`](https://github.com/arethetypeswrong/arethetypeswrong.github.io)
  should run beside this tool; `publish-clean` does not reimplement their
  compatibility checks.
- [`pkg-pr-new`](https://github.com/stackblitz-labs/pkg.pr.new) is the right
  model for previewing installable package artifacts before npm publication.
- [`changesets`](https://github.com/changesets/changesets),
  [`release-please`](https://github.com/googleapis/release-please),
  [`semantic-release`](https://github.com/semantic-release/semantic-release),
  [`release-it`](https://github.com/release-it/release-it), and
  [`np`](https://github.com/sindresorhus/np) own release orchestration. Use
  `publish-clean` as a guard or publish hook in those flows.
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
  provenance prove package origin; they do not prove the tarball contents are
  correct.

## Development

```bash
bun install --frozen-lockfile
bun run check
```

Before committing workflow changes, run:

```bash
actions-up --yes
```

This package intentionally has no runtime dependencies.

## License

Apache-2.0. Copyright 2026 Anizoptera and Art Shendrik.
