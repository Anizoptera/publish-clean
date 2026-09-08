# @anizoptera/publish-clean

Publish npm packages with a clean `package.json` and checks for unwanted files,
unresolved workspace dependencies and missing entry points.

[![npm version](https://img.shields.io/npm/v/@anizoptera/publish-clean?label=npm)](https://www.npmjs.com/package/@anizoptera/publish-clean)
[![Signed provenance](https://img.shields.io/badge/provenance-signed-2ea44f?logo=npm&logoColor=white)](https://www.npmjs.com/package/@anizoptera/publish-clean#provenance)
[![CI](https://github.com/Anizoptera/publish-clean/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/Anizoptera/publish-clean/actions/workflows/check.yml)
[![Node >=22](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](package.json)
[![Runtime deps](https://img.shields.io/badge/runtime_deps-0-2ea44f)](package.json)
[![License](https://img.shields.io/github/license/Anizoptera/publish-clean)](LICENSE)

`publish-clean` removes `devDependencies`, workspace settings and tool config from the
published manifest. Consumer fields and lifecycle helpers stay. Unknown fields are
reported for review and kept unless you choose to remove them.

It packs once with pnpm, cleans the manifest inside the tarball, checks that file, then
uploads it with npm. The checked bytes are the published bytes. Cleaning leaves your
source files alone; your pack hooks still run and can change them.

Preview, then publish:

```sh
pnpm exec publish-clean --dry-run
pnpm exec publish-clean -- --access public --tag latest --provenance
```

Requires Node.js 22+, pnpm and npm. The CLI has no runtime dependencies. The publish
command above needs [CI provenance setup](#publishing-a-public-package-from-ci).

## Install

| Project | Install                                 | Run                       |
| ------- | --------------------------------------- | ------------------------- |
| pnpm    | `pnpm add -D @anizoptera/publish-clean` | `pnpm exec publish-clean` |
| Bun     | `bun add -d @anizoptera/publish-clean`  | `bunx publish-clean`      |
| npm     | `npm i -D @anizoptera/publish-clean`    | `npm exec publish-clean`  |
| Yarn    | `yarn add -D @anizoptera/publish-clean` | `yarn publish-clean`      |

Both `pnpm` and `npm` must be on `PATH`, including in Bun, npm and Yarn projects and CI.
The CLI is one JavaScript file with no runtime dependencies. pnpm and npm are separate
requirements, not bundled dependencies.

For trusted publishing, use Node.js 22.14+ and npm 11.5.1+. Provenance requires a public
package, a public source repository and a supported CI provider. See
[npm's requirements](https://docs.npmjs.com/trusted-publishers/).

### Running it under Bun

gzip bytes depend on the runtime and version executing the CLI. To run it under Bun,
pass Bun the **file path**:

```sh
bun ./node_modules/.bin/publish-clean
```

The installed command has a Node shebang. Passing the file directly avoids relying on
how a package runner selects an interpreter or changes the child tools' environment.

Keep the runtime and its version fixed when rebuilding a release artifact. Node and
Bun can encode the same archive contents into different gzip bytes, which changes the
artifact's hash.

## Package managers

The CLI uses pnpm for workspace resolution and `publishConfig` overrides, and npm to upload the
checked tarball. The [packer comparison](docs/why-pnpm-and-npm.md) explains the trade-offs.

Starting through another package manager prints an advisory on stderr. It does not change
the packer or stop publication, and there is no option to suppress it.

For `workspace:` and `catalog:` specs, pnpm needs the installed dependency in the packing
package's own `node_modules`. Compatibility depends on your install layout.

Bun gives each package its own `node_modules`, so a Bun workspace packs as it stands: no
`pnpm-workspace.yaml`, no switching package managers. Yarn hoists workspace dependencies
to the root instead, so pnpm doesn't find them, and Yarn PnP writes no `node_modules` at
all. Both need a `pnpm-workspace.yaml` and one `pnpm install` before packing works. A Yarn
package with no `workspace:` or `catalog:` specs needs neither, because there's nothing to
resolve.

Install the workspace before packing. An unresolved workspace dependency stops packing:

```
ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL
```

Install with the layout described above, then retry.

## Pick your setup

### Publishing a public package from CI

Configure an npm trusted publisher for your repository and workflow filename, with
permission for direct `npm publish`. In the publish job, grant `id-token: write` so npm
can authenticate through GitHub OIDC without an npm token. Run tests in a separate job
and make the publish job depend on their success.

```yaml
# Inside the publish job, after its required check jobs have passed:
permissions:
  contents: read
  id-token: write
steps:
  - uses: actions/checkout@v7
  - uses: pnpm/action-setup@v6
    # Set packageManager in package.json to select your pnpm version.
  - uses: actions/setup-node@v7
    with:
      node-version: "24"
      registry-url: https://registry.npmjs.org
  - run: pnpm install --frozen-lockfile
  - run: pnpm run build
  - run: pnpm exec publish-clean -- --access public --tag latest --provenance
```

Use `--tag latest` for stable releases and `--tag next` for prereleases. npm defaults
to `latest`, so omitting the tag can give ordinary installs a prerelease.

For a new package name, follow the [first-publish setup](docs/first-publish.md).

To block direct publication from your source directory, add this hook. Publishing a
tarball does not run it:

```json
{
  "scripts": {
    "prepublishOnly": "node -e \"console.error('Publish with publish-clean.'); process.exit(1)\""
  }
}
```

### Keeping your existing release tool

If your release tool supports a custom upload command, use `publish-clean` there.
For a preview check only, add:

```json
{
  "scripts": {
    "prepublishOnly": "publish-clean --guard-only"
  }
}
```

It checks a pnpm-produced preview and exits without publishing. Your release tool still
creates and uploads its own artifact, which may differ: this gate does not validate those
uploaded bytes or clean their manifest. To publish the checked bytes, configure that tool
to invoke `publish-clean` for the upload instead.

### Looking at what would be published

```bash
pnpm exec publish-clean --dry-run
```

Prints the checked file list and cleaned `package.json`. Add `--tarball-out DIR` to keep
the tarball; otherwise temporary files are removed.

### Publishing a restricted package

```bash
publish-clean -- --access restricted --tag latest
```

Omit provenance for restricted packages. Leave `private: true` unset: it prohibits
publication, even to a private registry.

### Publishing one package out of a monorepo

```bash
publish-clean packages/my-lib -- --access public --tag next
```

## How it works

```mermaid
flowchart TD
  A[Your package directory] -->|pnpm pack| B[Tarball, file set chosen by pnpm]
  B --> C[Rewrite only package.json inside]
  C --> D[Final tarball]
  D --> E{Checks, all reading this tarball}
  E -->|any fails| F[Exit non-zero, publish nothing]
  E -->|all pass| G[npm publish this same tarball]
```

`--dry-run` and `--guard-only` validate the artifact, but skip publication preflight.
Neither proves that registry access, credentials, provenance requirements or repository
identity are correct. Pack hooks still run, including any network operations they perform.

## Why it works this way

### Why cleaning happens in the tarball

Cleaning stays out of the source tree so an interrupted publish cannot leave your
`package.json` half-edited. Pack hooks still run in the source directory and may change it.

### Why the tarball is edited instead of packed again

Uploading the checked tarball prevents npm from choosing files again.
Cleaning removes `files` from its manifest because installation no longer needs that
packing instruction. Repacking the cleaned directory could then fall back to ignore rules
and drop files the first pack included.

Only `package/package.json` is replaced. Other archive entries retain their bytes,
order and metadata, including pnpm's owner `0:0`, fixed timestamps and file modes.
The reader resolves USTAR and PAX paths before checking files and rejects malformed or
unsupported path metadata.

`pnpm pack` runs pack hooks, including `prepare` and `prepack`. npm runs no package
lifecycle scripts when uploading a tarball, so those hooks cannot change the checked
artifact during upload.

## What it checks

Publication stops when:

- the package is marked `private: true`
- the working tree has uncommitted changes (`--no-git-checks` to allow it)
- the package has no non-empty `files` array (`--skip-file-check` to allow it)
- the tarball contains a recognised test, CI, lockfile or `tsconfig` path
  (`--allow-suspicious` to allow it)
- a filename matches the protected rules for environment files, npm credentials, Git
  internals, `node_modules` or key files; these checks cannot be disabled
- a dependency is still written as `catalog:`, `workspace:`, `link:` or `portal:`, or a local
  dependency points outside the shipped files
- a declared entry point cannot resolve against the shipped files; checks account for
  extension lookup, conditions and fallbacks, and allow unmatched `sideEffects` globs
- rewriting the manifest changed anything else in the tarball
- GitHub trusted publishing or provenance is enabled, but the `repository` in your manifest
  is not the repository the workflow is running in

File guards check paths, not file contents. They cannot detect a credential embedded
in an otherwise allowed source file. See [the rules](src/artifact.ts).

## What the cleaned manifest keeps

The cleaner preserves consumer and registry fields: `name`, `version`, `license`,
`dependencies`, `peerDependencies` and their meta, `exports`, `main`, `module`, `types`,
`bin`, `engines`, `os`, `cpu`, `sideEffects` and `publishConfig`, among others.

It removes `files` after packing; installers extract the tarball without using that field.

It also removes `devDependencies`, `workspaces`, `pnpm`, `packageManager`, `overrides`,
`resolutions`, and the config blocks belonging to test runners, linters, formatters,
coverage tools, build systems and release tools. When `preinstall`, `install`, `postinstall`,
`prepare` or `uninstall` exists, the complete scripts block survives: a lifecycle may call
any helper script. Otherwise the development-only scripts block is removed.

Unknown fields are kept and reported:

```
publish-clean: these manifest fields are not recognised and are retained as-is:
  "someToolConfig"
Strip the ones consumers do not read, and acknowledge the ones they do:
  "publish-clean": { "devFields": ["someToolConfig"] }
  "publish-clean": { "keepFields": ["someToolConfig"] }
```

Unknown fields stay because removing an unfamiliar field can break a consumer's build.
Use `devFields` to remove a field you know is development-only, or `keepFields` to suppress
its report. Inspect the result with `--dry-run`.

## Options and config

```bash
publish-clean [options] [package-dir] [-- npm-publish-args]
```

Set project defaults in `package.json`. A CLI registry overrides the configured registry;
boolean flags enable their setting. Pass per-release npm options, such as dist-tags, after `--`:

```json
{
  "publish-clean": {
    "registry": "https://registry.npmjs.org",
    "skipFileCheck": false,
    "allowSuspicious": false,
    "noGitChecks": false,
    "devFields": ["customBuildOnlyField"],
    "keepFields": ["contributes"]
  }
}
```

| Flag                 | `package.json`    | What it does                                                                               |
| -------------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| `--dry-run`          | -                 | Validate a preview artifact and print its file list and cleaned `package.json`. |
| `--guard-only`       | -                 | Validate a preview artifact without the file list or manifest output. |
| `--tarball-out DIR`  | -                 | Copy the final tarball into `DIR` before publishing.                                       |
| `--registry URL`     | `registry`        | Set `publishConfig.registry` on the cleaned manifest, and publish to it.                   |
| `--skip-file-check`  | `skipFileCheck`   | Allow a manifest with no `files` array.                                                    |
| `--allow-suspicious` | `allowSuspicious` | Allow tests, CI config, lockfiles or `tsconfig` in the artifact.                           |
| `--no-git-checks`    | `noGitChecks`     | Allow publishing from a dirty working tree.                                                |
| -                    | `devFields`       | Extra manifest fields to strip.                                                            |
| -                    | `keepFields`      | Fields that belong in the published package, so stop reporting them.                       |
| -                    | [`validateArtifact`](#validate-the-final-artifact) | Run your checks on the cleaned tarball before copying or publishing it. |
| `-h`, `--help`       | -                 | Print usage, every flag, and the config keys.                                              |
| `-v`, `--version`    | -                 | Print the installed version.                                                               |

Arguments after `--` accept publication options only; `--help` lists them. Extra package
operands, workspace selectors, unknown options and values starting with `-` are rejected
so npm cannot substitute an unchecked package. For a filename starting with `-`, use `./`.
Pass the dist-tag explicitly: `--tag latest` for a normal public release.

`--tarball-out` saves the checked bytes in every mode, before any upload. You can inspect
them, attach them to a release or attest them, even if publication fails.

`registry` sets both the general and package-scope destination in the cleaned manifest.
Registry URLs must not contain usernames or passwords, including scoped destinations in
`publishConfig`. Configure npm authentication in npm configuration instead.

`skipFileCheck` waives the manifest's `files` requirement. `allowSuspicious` permits the
listed development files. Neither disables the protected filename checks.

Use `noGitChecks` for a build directory or another directory outside a Git repository.

`devFields` refuses known consumer fields such as `exports`, `bin`, `engines` and dependency
maps to prevent accidental removal.

Use `keepFields` for consumer fields the tool does not recognise, such as a VS Code
extension's `contributes` and `publisher`. It suppresses reports; it does not restore stripped fields.

### Validate the final artifact

Use `validateArtifact` to check what users will install, such as package imports or type declarations. Add the command to your `package.json`:

```json
{
  "publish-clean": {
    "validateArtifact": ["node", "scripts/check-artifact.mjs"]
  }
}
```

This runs `node scripts/check-artifact.mjs /absolute/path/to/package.tgz` from your package directory. Read the tarball path from `process.argv.at(-1)`; configured arguments come before it.

The command runs once after built-in checks and before publication or a `--tarball-out` copy. It also runs in `--dry-run` and `--guard-only` modes. The config is removed from the published manifest.

The first item must name an executable on `PATH` or by its path. Use `node` or `bun` to run scripts, including on Windows; `.cmd` shims are not supported. Arguments are passed literally, without a shell: no pipes, redirection or environment assignments. Relative paths start at your package directory.

Exit with code 0 to pass or a nonzero code to reject the package. A failed launch, failed check, or changed or deleted tarball stops publication and copying. Output is hidden on success and shown on failure, with a capture limit to bound memory use. Cancellation stops the command and its child processes before removing temporary files.

Your script runs with your permissions. Keep it read-only and wait for its child processes to finish; publish-clean does not sandbox it or protect other project files.

Check the supplied tarball. Packing again checks different bytes; calling publish-clean from the script runs the same hook again.

## What it does not do

Use your release tool for versions, changelogs, tags and GitHub releases. Configure trusted
publishing separately. Built-in checks verify declared paths. To test package imports or
type declarations, supply a [validation command](#validate-the-final-artifact).

Bundled `node_modules` are not allowed. pnpm may first reject `bundleDependencies` with:

```
Add "nodeLinker: hoisted" to pnpm-workspace.yaml or delete bundleDependencies
```

A hoisted layout can make pnpm pack them, but the resulting `node_modules` entries still
fail this tool's file checks. Use another publication path if you need to ship them.

## Related tools

[`clean-publish`](https://github.com/shashkovdanil/clean-publish) cleans a temporary copy
of the source tree before publishing. `publish-clean` instead cleans a pnpm-produced tarball.

That preserves pnpm's file selection and workspace resolution, and lets the checks read
the same bytes npm uploads.

Release tools such as [Changesets](https://github.com/changesets/changesets),
[semantic-release](https://github.com/semantic-release/semantic-release),
[release-please](https://github.com/googleapis/release-please),
[release-it](https://github.com/release-it/release-it) and [np](https://github.com/sindresorhus/np)
handle release tasks. See [integration](#keeping-your-existing-release-tool) for the
difference between a preview check and publishing through this CLI.

[`publint`](https://publint.dev) and
[`@arethetypeswrong/cli`](https://github.com/arethetypeswrong/arethetypeswrong.github.io)
check package entry points and TypeScript compatibility. Use them alongside this tool.

`npm publish --dry-run` previews npm's publication. It does not clean the manifest or apply
this tool's protected filename rules.

[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) authorises a CI
workflow to publish. Provenance links a release to its source and build; it does not
check package contents for you.

[`pkg-pr-new`](https://github.com/stackblitz-labs/pkg.pr.new) publishes preview builds
per commit without publishing a version to npm.

Underlying behaviour is defined by [`npm-packlist`](https://github.com/npm/npm-packlist),
[`npm pack`](https://docs.npmjs.com/cli/v11/commands/npm-pack/),
[`npm publish`](https://docs.npmjs.com/cli/v11/commands/npm-publish/),
[`pnpm pack`](https://pnpm.io/cli/pack) and pnpm
[`publishConfig`](https://pnpm.io/package_json#publishconfig).

## Contributing

```bash
bun install --frozen-lockfile
bun run check
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the rest. Security problems go through private
reporting, not public issues: see [SECURITY.md](SECURITY.md).

## License

Apache-2.0. Copyright 2026 Anizoptera and Art Shendrik.
