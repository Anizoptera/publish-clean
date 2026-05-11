# Related Tools

`publish-clean` sits between package-manager packing and release automation. It
does not try to replace either side.

## Package packing

- [`npm-packlist`](https://github.com/npm/npm-packlist) documents the file
  selection rules npm packages are built around.
- [`npm pack`](https://docs.npmjs.com/cli/v11/commands/npm-pack/) and
  [`npm publish`](https://docs.npmjs.com/cli/v11/commands/npm-publish/) define
  the baseline npm tarball and publish behavior.
- [`pnpm pack`](https://pnpm.io/cli/pack) and
  [`pnpm publish`](https://pnpm.io/cli/publish) are the target package-manager
  commands for this project because pnpm workspaces, catalogs, and
  `publishConfig` handling need pnpm-aware packing.

`publish-clean` uses the package-manager artifact as input instead of building
its own package-file selection rules.

## Cleanup

- [`clean-publish`](https://github.com/shashkovdanil/clean-publish) is the
  closest related package. It publishes from a cleaned copy of the project.

`publish-clean` follows the same source-tree-preserving idea, but keeps the
cleanup scope narrow: package metadata, dependency specs, declared files, and
dangerous package contents.

## Validation

- [`publint`](https://publint.dev/) checks package compatibility across common
  bundlers and runtimes.
- [`@arethetypeswrong/cli`](https://github.com/arethetypeswrong/arethetypeswrong.github.io)
  checks TypeScript declaration and module-resolution behavior.

These tools should run alongside `publish-clean`. They cover ecosystem
compatibility; `publish-clean` covers publication artifact hygiene.

## Release automation

- [`changesets`](https://github.com/changesets/changesets)
- [`release-please`](https://github.com/googleapis/release-please)
- [`semantic-release`](https://github.com/semantic-release/semantic-release)
- [`release-it`](https://github.com/release-it/release-it)
- [`np`](https://github.com/sindresorhus/np)

Those tools manage release intent, versions, changelogs, tags, GitHub releases,
and registry publication flows. `publish-clean` is useful as a guard or publish
command inside those flows.

## Preview and provenance

- [`pkg-pr-new`](https://github.com/stackblitz-labs/pkg.pr.new) is useful for
  previewing installable package artifacts from commits and pull requests.
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and npm
  provenance identify where a package was built and published.

Preview releases and provenance complement `publish-clean`; they do not inspect
or sanitize the package contents themselves.
