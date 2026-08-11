# Why pnpm packs and npm publishes

`publish-clean` always packs with `pnpm` and publishes with `npm`, whatever package
manager your project uses. This page is the evidence for that, for anyone who wants to
change it.

Measured against pnpm 11.21, npm 11.19 and Bun 1.3.14.

## The packer is not chosen for file selection

pnpm, npm and Bun select the same files. Same `files` field, same `.npmignore`, same
default rules. `publish-clean` adds no file rules of its own, so that part of packing
behaves however your package manager already behaves.

Everything else we compared came out identical too: file modes including the executable
bit on `bin`, negated `files` patterns, dropped symlinks, prerelease versions, pinned
`workspace:1.2.3` ranges, named catalogs, and refusing a catalog entry that does not
exist.

Workspaces are the only real difference, and they decide it.

## What a workspace dependency has to become

A dependency written as `"@acme/utils": "workspace:*"` means "whatever version of that
package is in this repo right now". Before it ships it has to become a real version
range, because `workspace:*` means nothing to a stranger installing from the registry.

npm never adopted the protocol. It will not install it:

```
npm error code EUNSUPPORTEDPROTOCOL
npm error Unsupported URL Type "workspace:": workspace:*
```

And `npm pack` on that same package exits 0 with `workspace:*` written straight into the
tarball. It neither resolves it nor refuses it. Silently publishing something nobody can
install is the one behaviour a release tool cannot be built on, so npm is out as a packer.

pnpm and Bun both resolve it, and both stop loudly when they cannot. Their output matches
down to `workspace:^` and `workspace:~` in `peerDependencies` and `optionalDependencies`,
and `catalog:` entries too. On plain correctness there is nothing to choose between them.

## pnpm rather than Bun: where each one looks

pnpm looks for the dependency in the packing package's own `node_modules` and resolves it
from there. It never asks who put it there. So a Bun workspace, which gives every package
its own `node_modules`, packs as readily as pnpm's own.

Bun reads `bun.lock` instead. It resolves the workspaces Bun installed and refuses the
rest:

```
error: Failed to resolve workspace version for "@acme/utils" in `dependencies`.
Run `bun install` and try again.
```

Accurate, and useless in a pnpm repo, where `bun install` is not something you want to be
told to run. A tool that executes in other people's repositories has to cope with the
repository it finds, so it packs with the one that reads all of them.

Yarn is the exception either way: it hoists workspace dependencies to the root, where
pnpm does not look, and Yarn PnP writes no `node_modules` at all. Both need a
`pnpm-workspace.yaml` and one `pnpm install` before packing works.

## pnpm rather than Bun: the silent one

An aliased workspace dependency, `"utils": "workspace:@acme/utils@*"`, has to come out the
other side as an npm alias. pnpm writes `"npm:@acme/utils@1.2.3"`. Bun 1.3.14 writes
`"@acme/utils@*"`: the `npm:` prefix is dropped and the range was never resolved. npm will
not take it.

```
npm error code EINVALIDTAGNAME
npm error Invalid tag name "is-odd@3.0.1" of package "aliased@is-odd@3.0.1"
```

`bun pm pack` exits 0 either way, so nothing tells you until someone tries to install the
release. One silent way to publish a broken manifest is one too many for the step you
cannot take back.

## pnpm alone applies publishConfig overrides

If your manifest points `main`, `types` and `exports` at source for local development and
overrides them to `dist` for publishing, pnpm swaps them on the way out and drops
`publishConfig` itself. npm and Bun ignore those overrides and publish the development
paths. That one is a pnpm extension rather than a bug in the other two, but the effect on
the release is the same.

## What pnpm costs: bundleDependencies

pnpm links dependencies rather than copying them, so it has nothing to bundle, and it
refuses the package outright:

```
Add "nodeLinker: hoisted" to pnpm-workspace.yaml or delete bundleDependencies
```

Doing what it says makes the package publishable again. This is the whole price of packing
with pnpm, and it is a fair one: `bundleDependencies` is rare, and the failure is loud and
names the fix.

For the record, npm and Bun bundle correctly for a standalone package, and neither bundles
anything for a package inside a workspace, because the dependency hoists to the workspace
root where the package cannot see it.

## Why npm publishes

Provenance is an npm feature. The signed attestation behind the "Built and signed on
GitHub Actions" badge is minted by the npm CLI talking to Sigstore, and trusted
publishing, which removes the long-lived token entirely, is npm's own OIDC exchange with
the registry.

No other client mints it. `bun publish` offers `--access`, `--tag`, `--otp` and
`--auth-type`, and nothing at all for provenance or attestation, so publishing through it
would cost both the badge and the tokenless path. That trade is not on the table:
verifiable provenance is why this package exists.

`npm publish` also takes a tarball directly, which is exactly what the packing step
produced.
