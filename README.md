# @anizoptera/publish-clean

[![npm version](https://img.shields.io/npm/v/@anizoptera/publish-clean?label=npm)](https://www.npmjs.com/package/@anizoptera/publish-clean)
[![CI](https://github.com/Anizoptera/publish-clean/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/Anizoptera/publish-clean/actions/workflows/check.yml)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![pnpm pack + publish](https://img.shields.io/badge/pnpm-pack%20%2B%20publish-f69220?logo=pnpm&logoColor=white)](https://pnpm.io/cli/pack)
[![Bun checked](https://img.shields.io/badge/Bun-checked-000000?logo=bun&logoColor=white)](https://bun.sh/docs/cli/test)
[![Runtime deps](https://img.shields.io/badge/runtime_deps-0-2ea44f)](package.json)
[![License](https://img.shields.io/github/license/Anizoptera/publish-clean)](LICENSE)

Publish a pnpm package from the tarball you actually intend to ship.

This is pnpm-first on purpose. `publish-clean` is built for packages that rely on
pnpm workspace, catalog, and publish behavior.

`publish-clean` runs `pnpm pack`, opens the packed package, checks for files and
manifest entries that should not ship, removes development-only metadata from
the extracted copy, and publishes that cleaned copy with `pnpm publish`.

Your working tree is left alone.

## Why use this

`pnpm pack` is good at workspace packages. It understands pnpm's workspace and
catalog behavior in a way generic cleanup scripts usually do not.

The rough edge is the packed manifest. It can still carry maintainer-only
fields: dev dependencies, test runner config, workspace tooling, local
overrides, and other project metadata consumers do not need.

`publish-clean` keeps pnpm in charge of deciding what the package is, then
cleans and validates the packed result before publication.

It is for packages that want the npm artifact to contain only what was meant to
ship:

- built files
- README
- license
- package metadata
- any other files the package intentionally exposes

No accidental tests, CI config, local agent docs, lockfiles, private keys, or
workspace-only dependency specs.

## Install

```bash
pnpm add -D @anizoptera/publish-clean
```

Requirements:

- Node.js 20 or newer
- `pnpm`
- `tar`

The CLI runs on Node. This repository uses Bun for fast local checks and tests.
Package creation and publication intentionally go through pnpm; npm, Yarn, and
Bun are not treated as equivalent pack/publish backends.

## Basic setup

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

Then publish with:

```bash
pnpm run publish:clean
```

Use a script name like `publish:clean` or `release`. Avoid naming it `publish`;
that collides too easily with npm lifecycle behavior.

## Commands

```bash
publish-clean --dry-run
publish-clean --guard-only
publish-clean --registry https://registry.npmjs.org -- --access public
publish-clean packages/my-lib -- --access public --tag next
```

Start with `--dry-run`. It prints the temporary extracted package path, so you
can inspect the exact package that would be published.

## What happens

```text
source package
  -> pnpm pack
  -> inspect tarball contents
  -> write cleaned package.json
  -> validate declared package paths
  -> pnpm publish from the cleaned package
```

With `--dry-run` or `--guard-only`, the last step is skipped.

## Options

```bash
publish-clean [options] [package-dir] [-- pnpm-publish-args]
```

- `--dry-run`: pack, check, clean, and print the extracted package path.
- `--guard-only`: run the guard path without publishing.
- `--registry URL`: set `publishConfig.registry` on the cleaned manifest.
- `--skip-file-check`: skip suspicious-file checks and the required `files`
  array check. Critical leak checks still run.
- `--no-git-checks`: skip the source git cleanliness check.
- `-h`, `--help`: print usage.

Arguments after `--` go to `pnpm publish`, run from the cleaned extracted
package.

## Package config

Stable project defaults can live in `package.json`:

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

Keep one-off choices on the command line. Dist-tags are a good example.

## What it checks

`publish-clean` refuses to continue when:

- the package is `private: true`
- the source package has uncommitted changes, unless disabled
- the package has no non-empty `files` array, unless disabled
- the tarball contains critical leaks like `.env`, `.npmrc`, `.git`,
  `node_modules`, or private-key files
- dependency specs still use `catalog:`, `workspace:`, `link:`, or `portal:`
- declared export, type, import, browser, bin, or side-effect paths are missing
  from the cleaned package

It also warns when a package-manager lifecycle looks like npm, Yarn, or Bun.
That warning is intentional: this tool relies on pnpm's pack and publish
behavior.

Critical leak checks cannot be disabled.

## What it removes

From the extracted package manifest, `publish-clean` removes maintainer-only
fields such as:

- `devDependencies`
- `workspaces`
- `pnpm`
- test, lint, format, coverage, build-system, and release-tool config fields
- scripts except consumer install lifecycle scripts

The repository files are not changed.

## What it does not do

This is not a release manager. It does not choose versions, write changelogs,
create tags, push commits, create GitHub releases, set up npm trusted
publishing, or decide your dist-tag policy.

Use tools like Changesets, release-please, semantic-release, release-it, or np
for that. Use `publish-clean` as the guard or final publish command.

It also does not replace package validators. Run `publint` and
`@arethetypeswrong/cli` for package compatibility checks.

## Related tools

This package borrows the useful part of
[`clean-publish`](https://github.com/shashkovdanil/clean-publish): publish from
a cleaned copy, not from a rewritten source tree.

It deliberately stays close to package-manager behavior instead of inventing its
own file-selection rules. The relevant tools and specs are
[`npm-packlist`](https://github.com/npm/npm-packlist),
[`npm pack`](https://docs.npmjs.com/cli/v11/commands/npm-pack/),
[`npm publish`](https://docs.npmjs.com/cli/v11/commands/npm-publish/),
[`pnpm pack`](https://pnpm.io/cli/pack),
[`pnpm publish`](https://pnpm.io/cli/publish), and pnpm
[`publishConfig`](https://pnpm.io/package_json#publishconfig).

For preview installs, see
[`pkg-pr-new`](https://github.com/stackblitz-labs/pkg.pr.new). For provenance,
use [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/). Both
are useful layers. Neither one cleans the package contents.

## Development

```bash
bun install --frozen-lockfile
bun run check
```

Before committing workflow changes:

```bash
actions-up --yes
```

This package has no runtime dependencies.

## License

Apache-2.0. Copyright 2026 Anizoptera and Art Shendrik.
