# @anizoptera/publish-clean

Pre-publish npm package cleaner that strips common useless noise and crap from
`package.json`; prevents accidental publication of unwanted things and unresolved
dependencies. No deps, one JS file.

[![npm version](https://img.shields.io/npm/v/@anizoptera/publish-clean?label=npm)](https://www.npmjs.com/package/@anizoptera/publish-clean)
[![Signed provenance](https://img.shields.io/badge/provenance-signed-2ea44f?logo=npm&logoColor=white)](https://www.npmjs.com/package/@anizoptera/publish-clean#provenance)
[![CI](https://github.com/Anizoptera/publish-clean/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/Anizoptera/publish-clean/actions/workflows/check.yml)
[![Node >=22.14](https://img.shields.io/badge/node-%3E%3D22.14-339933?logo=node.js&logoColor=white)](package.json)
[![Runtime deps](https://img.shields.io/badge/runtime_deps-0-2ea44f)](package.json)
[![License](https://img.shields.io/github/license/Anizoptera/publish-clean)](LICENSE)

When you run `npm publish`, two things ship that you probably did not mean to ship.

The first is your `package.json`. It is a development manifest: devDependencies, config
blocks for your test runner, linter and formatter, `packageManager`, `workspaces`, `pnpm`
settings, release-tool settings, and every script you run locally.
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

It packs with pnpm and publishes with npm, and cleans the manifest in between. Both
choices are argued, with measurements, in
[why pnpm packs and npm publishes](docs/why-pnpm-and-npm.md).

## Install

| Project | Install                                 | Run                       |
| ------- | --------------------------------------- | ------------------------- |
| pnpm    | `pnpm add -D @anizoptera/publish-clean` | `pnpm exec publish-clean` |
| Bun     | `bun add -d @anizoptera/publish-clean`  | `bunx publish-clean`      |
| npm     | `npm i -D @anizoptera/publish-clean`    | `npm exec publish-clean`  |
| Yarn    | `yarn add -D @anizoptera/publish-clean` | `yarn publish-clean`      |

**Whatever you start it with, `pnpm` prepares the package and `npm` uploads it, so both
must be on `PATH`.** A Bun, npm or Yarn project needs pnpm installed too, including in CI.

Also needs `tar` and Node.js 22.14+. Below 22.14 npm cannot mint provenance.

That installs one package and nothing else. `publish-clean` has zero runtime
dependencies: it is a single file that talks to `pnpm`, `npm` and `tar` through the
tools you already have. For something that sits on your publish path and handles your
registry credentials, that matters. A publishing tool with a dependency tree is a
supply-chain risk of its own, and this one has no transitive code to audit.

`--provenance` additionally needs npm 11.5.1+ and a cloud CI runner. npm will not sign a
publish that came from your laptop.

## Package managers

Why pnpm packs and npm publishes: pnpm is the only packer that resolves every workspace
layout correctly, and npm is the only client that can sign a release. The measurements are
in [why pnpm packs and npm publishes](docs/why-pnpm-and-npm.md).

Started with anything other than pnpm, it prints an advisory on stderr saying so. That is
a warning, not an error. Nothing behaves differently because of it, and there is no flag
to silence it.

For a single package every manager behaves the same, since nothing in the manifest needs
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

Prints every file that would ship and the cleaned `package.json`, then deletes its temp
tree. Add `--tarball-out DIR` to keep the tarball itself.

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
  A[Your package directory] -->|pnpm pack| B[Tarball, file set chosen by pnpm]
  B --> C[Copy it, rewriting only the package.json inside]
  C --> D[Final tarball]
  D --> E{Checks, all reading this tarball}
  E -->|any fails| F[Exit non-zero, publish nothing]
  E -->|all pass| G[npm publish this same tarball]
```

The checks are listed under [What it checks](#what-it-checks). The point of the shape is
that they all read the tarball that gets uploaded, so what passed the checks and what
reached the registry are the same bytes, not two things that ought to match.

`--dry-run` and `--guard-only` run the whole pipeline and stop before the publish.

## Why it works this way

### Why pnpm packs, and npm publishes

pnpm because of workspaces. A dependency written `"@acme/utils": "workspace:*"` has to
become a real version range before it ships, and pnpm is the only packer that does that
for every layout it might find, including a Bun one. npm writes `workspace:*` into the
tarball unchanged and exits 0, publishing a package nobody can install. Bun resolves only
what Bun installed, and quietly mangles an aliased workspace dependency.

npm because of provenance. The signed attestation behind the "Built and signed on GitHub
Actions" badge is minted by the npm CLI talking to Sigstore, and trusted publishing, which
removes the long-lived token entirely, is npm's own exchange with the registry. No other
client does either one. `npm publish` also takes a tarball directly, which is what the
packing step already produced.

The measurements behind both choices, and the one thing packing with pnpm costs you, are
in [why pnpm packs and npm publishes](docs/why-pnpm-and-npm.md).

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

Editing avoids the question. Only the `package/package.json` member is replaced. Every
other entry is copied without being decoded, so the file set stays exactly what pnpm chose,
and entry shapes this tool does not model (pax headers for long paths, prefix splitting)
pass through untouched. It also keeps pnpm's normalised metadata: owner `0:0`, a fixed
timestamp, mode 644. A plain `tar` invocation would replace those with whatever the build
machine happens to have.

Lifecycle scripts run once, at the first pack. `pnpm pack` runs your `prepare` and
`prepack`, which is how build output reaches the package at all. Nothing runs afterwards:
npm skips `prepack`/`postpack` when it is handed a tarball rather than a directory, so
nothing can alter the artifact after it was checked.

## What it checks

`publish-clean` stops, and publishes nothing, when:

- the package is marked `private: true`
- the working tree has uncommitted changes (`--no-git-checks` to allow it)
- the package has no non-empty `files` array (`--skip-file-check` to allow it)
- the tarball holds something that should never ship: a `.env`, an `.npmrc`, `.git`,
  `node_modules`, or a private key. This one has no off switch, by any flag or config key
- a dependency is still written as `catalog:`, `workspace:`, `link:` or `portal:`, which
  nobody outside your repo can install
- the manifest points `exports`, `types`, `main`, `browser`, `bin` or `sideEffects` at a
  path that is not in the tarball
- rewriting the manifest changed anything else in the tarball
- you asked for `--provenance` from GitHub Actions, but the `repository` in your manifest
  is not the repository the workflow is running in

It warns, without stopping, when it was started by npm, Yarn or Bun rather than pnpm. The
packing still goes through pnpm, but the warning is there because the rest of your release
probably should too.

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

## Options and config

```bash
publish-clean [options] [package-dir] [-- npm-publish-args]
```

Most settings can be a flag or a `package.json` key. Flags win, so keep per-release
choices like dist-tags on the command line and stable project policy in the manifest:

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

| Flag                | `package.json`  | What it does                                                                               |
| ------------------- | --------------- | ------------------------------------------------------------------------------------------ |
| `--dry-run`         | -               | Run everything up to the publish, then print the file list and the cleaned `package.json`. |
| `--guard-only`      | -               | Run everything up to the publish and exit, printing nothing.                               |
| `--tarball-out DIR` | -               | Copy the final tarball into `DIR` before publishing.                                       |
| `--registry URL`    | `registry`      | Set `publishConfig.registry` on the cleaned manifest, and publish to it.                   |
| `--skip-file-check` | `skipFileCheck` | Drop the suspicious-file check and the required `files` array.                             |
| `--no-git-checks`   | `noGitChecks`   | Allow publishing from a dirty working tree.                                                |
| -                   | `devFields`     | Extra manifest fields to strip.                                                            |
| -                   | `keepFields`    | Fields that belong in the published package, so stop reporting them.                       |
| `-h`, `--help`      | -               | Print usage.                                                                               |

Arguments after `--` go to `npm publish`. Pass the dist-tag explicitly: `--tag latest` for
a normal public release.

A few of these deserve a sentence more.

`--tarball-out` keeps the bytes that were published, so a release pipeline can attach them
to a GitHub Release or sign them with build-provenance attestation. The copy happens in
every mode, before the publish, so you get the validated artifact even if the upload fails.

`registry` pins where the package goes, so it cannot end up on whatever registry the
machine happens to be pointed at.

`skipFileCheck` does not touch the leak checks.

`noGitChecks` is what you need when you publish from a build directory, or from a checkout
that is not a git repository at all.

`devFields` refuses fields that npm or your consumers actually read, like `exports`, `bin`,
`engines` and the dependency maps, so a typo cannot quietly break your package.

`keepFields` answers the unrecognised-field report the other way: the field belongs in the
published package, stop mentioning it. A VS Code extension needs `contributes` and
`publisher` in the artifact to work, and no generic publishing tool is ever going to know
that.

## What it does not do

It isn't a release manager. It won't pick your version number, write a changelog, tag
anything, push a commit, create a GitHub release, or set up trusted publishing for you. It
also doesn't check that your entry points resolve correctly for consumers. Pair it with a
release manager and a validator; the next section names them.

It can't publish a package that uses `bundleDependencies`. pnpm links dependencies rather
than copying them, so it has nothing to bundle and refuses:

```
Add "nodeLinker: hoisted" to pnpm-workspace.yaml or delete bundleDependencies
```

Doing what it says makes the package publishable again. This is the one thing you give up
by packing with pnpm, and it's a fair trade: `bundleDependencies` is rare, and the failure
is loud and tells you the fix.

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
