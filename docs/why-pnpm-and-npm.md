# Why pnpm packs and npm publishes

pnpm resolves workspace dependencies and publishing overrides; npm uploads the checked
tarball without repacking it or running package scripts.

The packer comparisons below were measured against pnpm 11.21, npm 11.19 and Bun 1.3.14;
they are regression cases to rerun when evaluating another version, not universal claims.

## File selection

The compared packers selected the same files in the measured fixtures. File selection did
not distinguish them there. `publish-clean` preserves pnpm's selection and scans it;
it does not implement a competing packlist.

These fixtures also agreed on file modes including the executable
bit on `bin`, negated `files` patterns, dropped symlinks, prerelease versions, pinned
`workspace:1.2.3` ranges, named catalogs, and refusing a catalog entry that does not
exist.

Workspace resolution and manifest overrides provide the reasons for choosing pnpm.

## What a workspace dependency has to become

A dependency written as `"@acme/utils": "workspace:*"` means "whatever version of that
package is in this repo right now". Before it ships it has to become a real version
range, because `workspace:*` means nothing to a stranger installing from the registry.

npm never adopted the protocol. It will not install it:

```
npm error code EUNSUPPORTEDPROTOCOL
npm error Unsupported URL Type "workspace:": workspace:*
```

In the comparison, `npm pack` exited 0 with `workspace:*` still in the tarball.
That leaves an unresolvable dependency in the published package.

pnpm and Bun both resolve it, and both stop loudly when they cannot. Their output matches
down to `workspace:^` and `workspace:~` in `peerDependencies` and `optionalDependencies`,
and ordinary `catalog:` entries too. Aliases and installer layouts expose differences below.

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

pnpm's resolution also works with dependencies installed by Bun, without requiring a
different installer or lockfile. Bun's resolution required a Bun install.

Yarn is the exception either way: it hoists workspace dependencies to the root, where
pnpm does not look, and Yarn PnP writes no `node_modules` at all. Both need a
`pnpm-workspace.yaml` and one `pnpm install` before packing works.

## Workspace aliases

An aliased workspace dependency, `"utils": "workspace:@acme/utils@*"`, has to come out the
other side as an npm alias. pnpm writes `"npm:@acme/utils@1.2.3"`. Bun 1.3.14 writes
`"@acme/utils@*"`: the `npm:` prefix is dropped and the range was never resolved. npm will
not take it.

```
npm error code EINVALIDTAGNAME
npm error Invalid tag name "is-odd@3.0.1" of package "aliased@is-odd@3.0.1"
```

`bun pm pack` exited 0 for this case despite producing an invalid dependency spec.

## pnpm alone applies publishConfig overrides

If your manifest points `main`, `types` and `exports` at source for local development and
overrides them to `dist` for publishing, pnpm swaps them on the way out and removes the
consumed overrides. Publication settings such as access and registry remain. npm and Bun
in the comparison ignored those overrides and published the development
paths. That one is a pnpm extension rather than a bug in the other two, but the effect on
the release is the same. See [pnpm's override contract](https://pnpm.io/package_json#publishconfig).

## What pnpm costs: bundleDependencies

pnpm links dependencies rather than copying them, so it has nothing to bundle, and it
refuses the package outright:

```
Add "nodeLinker: hoisted" to pnpm-workspace.yaml or delete bundleDependencies
```

A hoisted layout permits bundling in pnpm, but `publish-clean` still refuses the resulting
`node_modules` entries. That is this tool's artifact policy, not a packer limitation that
switching linkers solves.

In the tested layouts, npm and Bun bundled dependencies in standalone packages but not
workspace packages whose dependencies were hoisted to the workspace root.

## Why npm publishes

`npm publish <tarball>` uploads the file's bytes; its provenance subject is the SHA-512
of those bytes. It runs no package lifecycle scripts for a tarball input. The implementation
paths are [pacote FileFetcher](https://github.com/npm/pacote/blob/main/lib/file.js),
[libnpmpublish](https://github.com/npm/cli/blob/latest/workspaces/libnpmpublish/lib/publish.js)
and [libnpmpack](https://github.com/npm/cli/blob/latest/workspaces/libnpmpack/lib/index.js).
The loopback registry test also compares npm's attachment with the retained artifact.

Provenance is not exclusive to npm: [pnpm documents native publishing and --provenance](https://pnpm.io/cli/publish).
Replacing npm requires evidence for artifact preservation, lifecycle behavior,
registry selection and trusted publication;
support for an attestation option alone does not establish those properties. npm remains the
chosen uploader.
