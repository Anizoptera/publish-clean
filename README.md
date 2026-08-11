# @anizoptera/publish-clean

Publish npm packages with a consumer-only `package.json`. Refuses to ship a `.env`, a
private key, or an unresolved workspace dependency.

[![npm version](https://img.shields.io/npm/v/@anizoptera/publish-clean?label=npm)](https://www.npmjs.com/package/@anizoptera/publish-clean)
[![Signed provenance](https://img.shields.io/badge/provenance-signed-2ea44f?logo=npm&logoColor=white)](https://www.npmjs.com/package/@anizoptera/publish-clean#provenance)
[![CI](https://github.com/Anizoptera/publish-clean/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/Anizoptera/publish-clean/actions/workflows/check.yml)
[![License](https://img.shields.io/github/license/Anizoptera/publish-clean)](LICENSE)

[![Runtime deps](https://img.shields.io/badge/runtime_deps-0-2ea44f)](package.json)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![pnpm pack + npm publish](https://img.shields.io/badge/pnpm_pack%20%2B%20npm_publish-f69220?logo=pnpm&logoColor=white)](https://pnpm.io/cli/pack)
[![Bun checked](https://img.shields.io/badge/Bun-checked-000000?logo=bun&logoColor=white)](https://bun.sh/docs/cli/test)

When you run `npm publish`, two things ship that you probably did not mean to ship.

The first is your `package.json`. It is a development manifest. It lists devDependencies,
config blocks for your test runner and linter and formatter, `packageManager`,
`workspaces`, `pnpm` settings, release-tool settings, and every script you run locally.
npm sends all of it, unchanged, to everyone who installs your package. In a pnpm
workspace it can also send `workspace:*` and `catalog:` specs that were never resolved,
and those break the install for every consumer.

The second is files. A `.env`, an `.npmrc` with a token in it, a stray `.pem`, your
tests, `.github/`, a lockfile. You do not see the tarball before it goes out, and once a
version is published you cannot edit it. Unpublishing only works for a short window and
under conditions npm decides.

`publish-clean` packs the package once, rewrites the `package.json` inside that tarball
down to what consumers actually use, checks the result, and publishes those exact bytes.
Your working tree is never modified. If the artifact still has something in it that should
not ship, or declares a `main`, `exports`, or `bin` path that is not in the tarball, it
fails instead of publishing.

It uses pnpm to pack and npm to publish, and cleans the manifest in between. The
reasoning behind that is in [Why it works this way](#why-it-works-this-way).

## Install

```bash
pnpm add -D @anizoptera/publish-clean
```

That installs one package and nothing else. `publish-clean` has zero runtime
dependencies: it is a single file that talks to `pnpm`, `npm` and `tar` through the
tools you already have. For something that sits on your publish path and handles your
registry credentials, that matters. A publishing tool with a dependency tree is a
supply-chain risk of its own, and this one has no transitive code to audit.

Needs Node.js 20+, and `pnpm`, `npm` and `tar` on `PATH`.

`--provenance` also needs Node.js 22.14+, npm 11.5.1+, and a cloud CI runner. npm will
not sign a publish that came from your laptop.

## Package managers

Start `publish-clean` with any package manager and it still packs with `pnpm` and
publishes with `npm`. So both have to be installed even if your project uses neither. The
reasons are in [Why it works this way](#why-it-works-this-way).

| Your project | How to run it             | What to expect                                            |
| ------------ | ------------------------- | --------------------------------------------------------- |
| pnpm         | `pnpm exec publish-clean` | Everything works, no warning.                             |
| npm          | `npm exec publish-clean`  | Works. Prints an advisory that packing goes through pnpm. |
| Yarn         | `yarn publish-clean`      | Same as npm.                                              |
| Bun          | `bunx publish-clean`      | Same as npm.                                              |

The advisory is a warning on stderr, not an error. Nothing behaves differently because of
it and there's no flag to silence it. Worth seeing once if the rest of your pipeline runs
on something other than pnpm.

For a single package all four behave the same, since nothing in the manifest needs
resolving before it ships.

Monorepos are where it matters. `pnpm pack` resolves `workspace:` and `catalog:` specs by
finding the dependency inside the packing package's own `node_modules`. What decides
whether that works is the layout your installer left behind, not which installer it was.

Bun gives each package its own `node_modules`, so a Bun workspace packs as it stands: no
`pnpm-workspace.yaml`, no switching package managers. Yarn hoists workspace dependencies
to the root instead, so pnpm doesn't find them, and Yarn PnP writes no `node_modules` at
all. Both need a `pnpm-workspace.yaml` and one `pnpm install` before packing works. A Yarn
package with no `workspace:` or `catalog:` specs needs neither, because there's nothing to
resolve.

Either way the workspace has to be installed. Pack one nobody has installed and it stops
on pnpm's own error:

```
ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL
```

Which is what you want. Nothing gets published, and a manifest that would have been
uninstallable for everyone never reaches the registry. Run your usual install and pack
again.

## Pick your setup

### Publishing a public package from CI

The common case. `id-token: write` is what lets npm sign the release. Once trusted
publishing is configured for the package, no npm token is involved at all.

```yaml
# .github/workflows/release.yml
permissions:
  contents: read
  id-token: write
steps:
  - uses: actions/checkout@v7
  - uses: pnpm/action-setup@v6
  - uses: actions/setup-node@v7
    with:
      node-version: "24"
      registry-url: https://registry.npmjs.org
  - run: pnpm install --frozen-lockfile
  - run: pnpm run build
  - run: pnpm exec publish-clean -- --access public --tag latest --provenance
```

Always pass the dist-tag. npm defaults to `latest`, which is wrong for a prerelease and
easy to forget.

Publishing a package name for the first time cannot use trusted publishing at all. That
case has its own page: [docs/first-publish.md](docs/first-publish.md).

To stop a stray `npm publish` from bypassing all of this:

```json
{
  "scripts": {
    "prepublishOnly": "node -e \"console.error('Publish with publish-clean.'); process.exit(1)\""
  }
}
```

### Keeping your existing release tool

If Changesets, semantic-release, release-it or np already owns your releases, use
`publish-clean` as a check rather than replacing the publish:

```json
{
  "scripts": {
    "prepublishOnly": "publish-clean --guard-only"
  }
}
```

It packs, cleans and validates, then exits without publishing. A leaked file, an
unresolved `workspace:` spec or a `main` path that is missing from the tarball fails the
release before your tool uploads anything. The limit is real though: your tool still
publishes its own tarball, so you get the checks and not the cleaned manifest.

### Looking at what would be published

```bash
pnpm exec publish-clean --dry-run
```

Prints the paths of the cleaned package and the exact tarball that would be uploaded, and
leaves both on disk. Run `tar tzf` on the tarball and read the rewritten `package.json`.

### Publishing a restricted package

```bash
publish-clean -- --access restricted --tag latest
```

No provenance here, because npm only signs public packages. Do not set `private: true`
either. npm treats it as a publish block, and `publish-clean` refuses it too.

### Publishing one package out of a monorepo

```bash
publish-clean packages/my-lib -- --access public --tag next
```

## How it works

```mermaid
flowchart TD
  A[Your package directory] -->|pnpm pack| B[Tarball - pnpm decides the file set]
  B --> C[Clean its package.json for consumers]
  C -->|replace that one member| D[Same tarball, cleaned manifest]
  D --> E{Same file set as the pack?}
  E --> F{No leaked files?}
  F --> G{Every declared main/exports/bin/types path is in it?}
  G -->|extract it| H{Manifest that came out is the one we approved?}
  H --> I[npm publish that tarball]
```

Every gate reads the tarball that gets uploaded, so what passes the checks and what
reaches the registry are the same bytes rather than two things that ought to match.

Any gate that fails exits non-zero and nothing is published. `--dry-run` and
`--guard-only` run the whole pipeline and stop before the publish.

## Why it works this way

### Why pnpm does the packing

Not for file selection. pnpm, npm and Bun pick the same files: same `files` field, same
`.npmignore`, same packlist defaults. There are no file rules of this tool's own either,
so that part behaves however your package manager already behaves.

Workspaces are the reason. A dependency written as `"@acme/utils": "workspace:*"` means
"whatever version of that package is in this repo right now". It has to become a real
version range before it ships, because to a stranger installing from the registry
`workspace:*` means nothing.

npm never adopted the protocol. It won't even install it:

```
npm error code EUNSUPPORTEDPROTOCOL
npm error Unsupported URL Type "workspace:": workspace:*
```

`npm pack` on that same package exits 0 and writes `workspace:*` straight into the
tarball. It neither resolves it nor refuses it, and silently publishing something you
can't install is the one behaviour a release tool can't be built on.

pnpm and Bun both resolve it, and both stop loudly when they can't. Their output matches
down to `workspace:^` and `workspace:~` in `peerDependencies` and `optionalDependencies`,
and `catalog:` entries too. On correctness there is nothing to choose between them.

### Why pnpm rather than Bun

They resolve from different places, and that decides it.

pnpm looks for the dependency in the packing package's own `node_modules` and resolves it
from there. It never asks who put it there, so a Bun workspace, which gives every package
its own `node_modules`, packs as readily as pnpm's own. Yarn hoists to the root instead
and needs the one-time setup above.

Bun reads `bun.lock`. It resolves the workspaces Bun installed and refuses the others:

```
error: Failed to resolve workspace version for "@acme/utils" in `dependencies`.
Run `bun install` and try again.
```

That message is accurate and useless, because in a pnpm repo `bun install` is not
something you want to be told to run. A tool that executes in other people's
repositories has to cope with the repository it finds, so it packs with the one that
reads all of them.

There's a correctness gap too, and it's the quiet kind. An aliased workspace dependency,
`"utils": "workspace:@acme/utils@*"`, has to come out the other side as an npm alias.
pnpm writes `"npm:@acme/utils@1.2.3"`. Bun 1.3.14 writes `"@acme/utils@*"`: the `npm:`
prefix is dropped and the range was never resolved. npm won't take it.

```
npm error code EINVALIDTAGNAME
npm error Invalid tag name "is-odd@3.0.1" of package "aliased@is-odd@3.0.1"
```

`bun pm pack` exits 0 either way, so nothing tells you until someone tries to install the
release.

One silent way to publish a broken manifest is one too many for the step you can't take
back.

pnpm also applies `publishConfig` field overrides. If your manifest points `main`, `types`
and `exports` at source for local development and overrides them to `dist` for publishing,
pnpm swaps them on the way out and drops `publishConfig` itself. npm and Bun both ignore
those overrides and publish the development paths. That one is a pnpm extension rather
than a bug in the other two, but the effect on the release is the same.

Everything else we compared came out identical: file modes including the executable bit on
`bin`, negated `files` patterns, dropped symlinks, prerelease versions, pinned
`workspace:1.2.3` ranges, named catalogs, and refusing a catalog entry that doesn't exist.

### Why the manifest is cleaned on a copy

The manifest is read out of the packed tarball and written back into a copy of it, in a
temp directory. Your working tree is never touched.

The obvious alternative is what a lot of hand-rolled release scripts do: edit
`package.json`, publish, edit it back. That's fine until something dies in the middle,
and then your repo is sitting on a manifest nobody meant to keep. It also can't be run
twice at once. Cleaning a copy has neither problem and costs a directory in `/tmp`.

### Why the tarball is edited instead of packed again

Give npm a directory and it packs during the upload, so the bytes that reach the registry
only come into existence after the last check has run. Packing first means they exist
before anything is uploaded: they can be listed, scanned for leaks, kept with
`--tarball-out` for a build attestation, and then published as themselves. What you
inspect is what ships.

So the manifest has to be cleaned inside a tarball that already exists. The obvious way is
to unpack, edit, and pack again — and it is wrong. `files` is a packing instruction, and
cleaning removes it, because it is useless to anyone installing the package. A second pack
then has nothing left to select with, falls back to your `.gitignore`/`.npmignore` for
exclusion, and quietly drops files the first pack included. A package shipping a
`.gitignore` that excludes any other shipped file loses it.

Editing avoids the whole question. Only the `package/package.json` member is replaced;
every other entry is copied without being decoded, so the file set stays exactly what pnpm
chose and entry shapes this tool does not model (pax headers for long paths, prefix
splitting) pass through untouched. It also keeps pnpm's normalised metadata — owner `0:0`,
a fixed timestamp, mode 644 — which a plain `tar` invocation would replace with the build
machine's own user and group names.

Lifecycle scripts run once, at the first pack. `pnpm pack` runs your `prepare` and
`prepack`, which is how build output reaches the package at all. Nothing runs afterwards:
npm skips `prepack`/`postpack` when it is handed a tarball rather than a directory, so
nothing can alter the artifact after it was checked.

### Why npm does the publishing

Provenance is an npm feature. The signed attestation behind the "Built and signed on
GitHub Actions" badge is minted by the npm CLI talking to Sigstore, and trusted
publishing, which removes the long-lived token entirely, is npm's own OIDC exchange with
the registry.

No other client mints it. `bun publish` offers `--access`, `--tag`, `--otp` and
`--auth-type`, and nothing at all for provenance or attestation, so publishing through it
would cost both the badge and the tokenless path. That trade isn't on the table here:
verifiable provenance is why this package exists.

`npm publish` also takes a tarball directly, which is exactly what the previous step
produced.

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
- rewriting the manifest changed the tarball's file set in any way
- trusted GitHub publication uses `--provenance` but package repository metadata
  does not match the workflow repository

It warns, without stopping, when it was started by npm, Yarn or Bun rather than pnpm.
The packing still goes through pnpm, but the warning is there because the rest of your
release probably should too.

Leak checks cannot be turned off by any flag or config key.

## What the cleaned manifest keeps

Everything a consumer or a registry reads survives: `name`, `version`, `license`,
`dependencies`, `peerDependencies` and their meta, `exports`, `main`, `module`, `types`,
`bin`, `engines`, `os`, `cpu`, `sideEffects`, `publishConfig`, and the rest of the public
surface.

`files` goes, because it is spent: it told the packer what to include, the tarball already
exists, nothing re-selects afterwards, and an install extracts every entry unfiltered. npm
agrees — its registry drops the field from the metadata it serves.

What else goes: `devDependencies`, `workspaces`, `pnpm`, `packageManager`, `overrides`,
`resolutions`, and the config blocks belonging to test runners, linters, formatters,
coverage tools, build systems and release tools. Scripts go too, apart from the install
lifecycle ones a consumer actually runs: `preinstall`, `install`, `postinstall`,
`prepare` and `uninstall`.

Anything the tool does not recognise ships, and you get told it did:

```
publish-clean: these manifest fields are not recognised and were published as-is:
  someToolConfig
Strip the ones consumers do not read, and acknowledge the ones they do:
  "publish-clean": { "devFields": ["someToolConfig"] }
  "publish-clean": { "keepFields": ["someToolConfig"] }
```

The strip list cannot know about a tool invented after it was written, so new
`package.json` keys would otherwise leak into every install unnoticed. Dropping them
instead would be worse: a key some consumer actually resolves would vanish, and you would
hear about it from a stranger's broken build rather than from your own release.

Add your own with `devFields`. Better still, run `--dry-run` and read the manifest that
would ship instead of trusting this list.

## Options

```bash
publish-clean [options] [package-dir] [-- npm-publish-args]
```

- `--dry-run`: pack, check, clean, and print the cleaned package and final
  tarball paths.
- `--guard-only`: run the full pack, clean, and final-tarball guard without
  publishing.
- `--registry URL`: set `publishConfig.registry` on the cleaned manifest.
- `--skip-file-check`: skip suspicious-file checks and the required `files`
  array check. Critical leak checks still run.
- `--no-git-checks`: skip the source git cleanliness check.
- `--tarball-out DIR`: copy the final tarball into `DIR` before publishing. The bytes
  kept are the ones that were published, so a release pipeline can attach them to a
  GitHub Release or sign them with build-provenance attestation.
- `-h`, `--help`: print usage.

Arguments after `--` go to `npm publish`, which publishes the final cleaned
tarball.

Pass the npm dist-tag explicitly. For normal public releases, use
`--tag latest`.

## Package config

Stable project defaults can live in `package.json`:

```json
{
  "publish-clean": {
    "registry": "https://registry.npmjs.org",
    "skipFileCheck": false,
    "noGitChecks": false,
    "devFields": ["customBuildOnlyField"],
    "keepFields": ["contributes"]
  }
}
```

`registry` is written as `publishConfig.registry` on the cleaned manifest and passed to
`npm publish`, so the package cannot end up on whatever registry the machine happens to
be pointed at.

`skipFileCheck` drops the suspicious-file check and the requirement for a `files` array.
Leak checks keep running; those cannot be turned off.

`noGitChecks` allows publishing from a dirty working tree. You need it when you publish
from a build directory or a checkout that is not a git repository.

`devFields` lists extra manifest fields to strip, for tooling this package has not heard
of. Fields that npm or your consumers actually use, like `exports`, `bin`, `engines` and
the dependency maps, are rejected here, so a typo cannot quietly break your package.

`keepFields` is the other answer to the same report: the field belongs in the published
package, stop mentioning it. A VS Code extension needs `contributes` and `publisher` in
the artifact to work, and no generic publishing tool is ever going to know that.

Command-line flags override this block. Keep per-release choices such as dist-tags on the
command line.

## What it does not do

It isn't a release manager. It won't pick your version number, write a changelog, tag
anything, push a commit, create a GitHub release, or set up trusted publishing for you.
It also doesn't check that your entry points resolve correctly for consumers, which is
what `publint` and `@arethetypeswrong/cli` are for.

Pick a release manager and a validator to go with it. The next section covers which.

It can't publish a package that uses `bundleDependencies`. pnpm links dependencies rather
than copying them, so it has nothing to bundle and refuses:

```
Add "nodeLinker: hoisted" to pnpm-workspace.yaml or delete bundleDependencies
```

Doing what it says makes the package publishable again. This is the one thing you give up
by packing with pnpm, and it's a fair trade: `bundleDependencies` is rare, and the failure
is loud and tells you the fix. npm and Bun bundle correctly for a standalone package, and
neither bundles anything for a package inside a workspace, because the dependency hoists
to the workspace root where the package can't see it.

## How it compares

[`clean-publish`](https://github.com/shashkovdanil/clean-publish) is the closest prior
art, and the reason this package exists at all. It copies your source tree into a temp
directory, deletes the files and fields it recognises, and publishes that.

The difference is where the file list comes from. clean-publish starts with your whole
source tree and subtracts, so anything its rules do not recognise gets published.
`publish-clean` starts from what `pnpm pack` produced, which is already the exact file
list your package manager would have shipped, including `files`, `.npmignore`, packlist
rules and resolved `workspace:` specs. Only the manifest is rewritten after that, and the
result is validated again before upload. clean-publish does not re-check its output.

Release managers ([Changesets](https://github.com/changesets/changesets),
[release-please](https://github.com/googleapis/release-please),
[semantic-release](https://github.com/semantic-release/semantic-release),
[release-it](https://github.com/release-it/release-it),
[np](https://github.com/sindresorhus/np)) pick versions, write changelogs, tag, and call
`npm publish`. None of them look inside the tarball. Use one of them together with this,
via the `--guard-only` setup above.

[`publint`](https://publint.dev) and
[`@arethetypeswrong/cli`](https://github.com/arethetypeswrong/arethetypeswrong.github.io)
check that your entry points and type definitions resolve properly for consumers. That is
a different question from what is in the tarball. Run them as well.

`npm publish --dry-run` prints the file list and stops there. It does not clean anything
and will happily list a `.env` without complaining.

[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) proves who
published. This tool decides what gets published. They solve different halves of the same
worry, and this package is built to use both.

[`pkg-pr-new`](https://github.com/stackblitz-labs/pkg.pr.new) publishes preview builds
per commit without touching the registry. Useful next to this, unrelated to cleaning.

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
