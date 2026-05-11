# Related Tools

`publish-clean` sits between package-manager packing and release automation.
That is a small lane, but it matters: by the time a package is published, the
tarball is the truth.

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

`publish-clean` starts from the package-manager artifact instead of maintaining
a second set of file-selection rules.

## Cleanup

- [`clean-publish`](https://github.com/shashkovdanil/clean-publish) is the
  closest related package. It publishes from a cleaned copy of the project.

`publish-clean` keeps the cleaned-copy approach, but narrows the cleanup to
package metadata, dependency specs, declared files, and dangerous package
contents.

## Validation

- [`publint`](https://publint.dev/) checks package compatibility across common
  bundlers and runtimes.
- [`@arethetypeswrong/cli`](https://github.com/arethetypeswrong/arethetypeswrong.github.io)
  checks TypeScript declaration and module-resolution behavior.

Run these alongside `publish-clean`. They answer different questions:
compatibility for consumers, not package cleanup.

## Release automation

- [`changesets`](https://github.com/changesets/changesets)
- [`release-please`](https://github.com/googleapis/release-please)
- [`semantic-release`](https://github.com/semantic-release/semantic-release)
- [`release-it`](https://github.com/release-it/release-it)
- [`np`](https://github.com/sindresorhus/np)

Those tools manage versions, changelogs, tags, GitHub releases, and registry
flows. `publish-clean` fits as a guard or publish command inside them.

## Preview and provenance

- [`pkg-pr-new`](https://github.com/stackblitz-labs/pkg.pr.new) is useful for
  previewing installable package artifacts from commits and pull requests.
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and npm
  provenance identify where a package was built and published.

Preview releases and provenance complement `publish-clean`. They do not inspect
or sanitize the package contents themselves.
