# Changelog

Notable changes per release, newest first. This file is the source of the GitHub Release
notes: the section for a version is published verbatim when its tag is pushed.

## Unreleased

One run now reports everything wrong with the package and stops at the end, instead of failing at
the first defect. New checks cover packed names, `bin` shebangs and shipped files nothing reaches.
`exports` and `imports` are repaired where the result is provably identical.

### Upgrade notes

- The `[healed]` severity is gone. A repair no longer changes how bad a defect is, only whether the
  run stops: a repaired breakage prints `[error]` with the repair stated beside it, and never stops
  the run. Anything parsing `[healed]` must read the message instead.
- `--guard-only` still works and now says it is deprecated. Use `verify`, which also accepts a
  `private: true` package.
- The refusals below are new. Run `publish-clean verify` against your package before you upgrade a
  release pipeline.

### New refusals

Each one reaches consumers and cannot be repaired without guessing what you meant:

- **A packed name that does not survive extraction.** Two names differing only in letter case or
  Unicode form collapse onto one path on macOS and Windows, which ignore both by default. Two files
  means one silently overwrites the other and the install still reports success; a file colliding
  with a directory means the install fails outright. Only a case-sensitive filesystem can produce
  such a pair, which is why the author never sees it. Separately, a name Windows cannot create — a
  path component named after a DOS device (`aux`, `con`, `nul`, `com1`…, with or without an
  extension), a `:` or `?`, a trailing dot or space — fails every Windows install. Set
  `"os": ["!win32"]` if the package genuinely does not run on Windows and that half stops applying;
  a path component over 255 bytes is refused regardless, because no filesystem accepts one.
- **A `bin` file with no shebang, or one ending in CR.** An installer symlinks the file and the
  command is executed directly, so without that first line Linux and macOS fail with `exec format
  error` and npm has no interpreter to write into its Windows shim. A trailing CR is worse than no
  shebang and invisible in an editor: the kernel looks for an interpreter literally named `node\r`.
  A `bin` file holding a NUL byte in its first 512 bytes is exempt — it is a compiled binary.
- **A `require` condition resolving to an ES module.** Node can require one only from 20.19 and
  22.12 onward, a consumer can still switch it off, and top-level await fails on every version.
  Point `require` at a CommonJS build, or add a `module-sync` branch — that condition exists so
  `require()` and `import` can share one ES module.
- **A condition order that hands a consumer the wrong target** — a runtime key such as `node`
  placed after a generic one that points elsewhere, so Node gets the generic build. Only refused
  when the order cannot be corrected safely; where it can, it is repaired instead (below).
- **A self-import through a subpath your own `exports` does not expose.** It resolves for nobody,
  and it looks correct in your repository, where the same import resolves by path.
- **A shipped file importing another by the wrong letter case.** Works on the author's macOS,
  fails on a consumer's Linux.
- **A shipped file nothing reaches** — no entry point, no import from a reached file, no script.
  It runs only when the package has an `exports` field, because that is what makes unlisted paths
  unimportable — without it every shipped file is reachable and none is dead. Declare the
  deliberate ones:
  `"publish-clean": { "allowUnreferenced": ["assets"] }`, matched as a prefix, so naming a
  directory covers everything under it. The message prints the entry for you.

### Manifest repairs

`exports` and `imports` are flattened into the resolution they produce for every possible consumer,
then rewritten only where the result is provably identical: a condition repeating what a later key
already yields is dropped, `{"default": "./x.js"}` collapses to the string, and keys that real
resolvers require in a fixed order are put in it. Repairs land in the published manifest only and
never touch your source.
`--no-heal`, or `"publish-clean": { "heal": false }`, reports without rewriting.

`types` is the exception, and the only rewrite that deliberately changes what somebody resolves.
Only a type checker activates it, so nothing that runs your package can tell the difference:

- a branch pointing at JavaScript with no declaration file beside it is **removed**. It promised an
  API the package does not carry, and a checker was reading that JavaScript as your declarations and
  typing everything `any`. A checker now reports an untyped package instead of an invented one.
- declarations hidden behind a key that leads a checker nowhere are **moved to the front**, where
  every checker looks first.

Both print as errors and neither stops the publish, because the published artifact is correct.
Under `--no-heal` neither repair is applied, and then both defects stop it. Whatever the packed file
list cannot settle is left exactly
as written: a `types` target the package does not ship stays a missing-file report naming the path,
and nothing moves across a condition this tool does not recognise, since a private name may be meant
for a consumer configured to take it.

Defects that would need a guess are reported and left alone: a branch no consumer reaches, a
consumer no branch serves, a condition name no known runtime or bundler activates, anything inside
a fallback array (Bun resolves those differently from Node and Deno, so no rewrite is safe for
everyone), and a map too large to enumerate.

### Added

- **`publish-clean verify`** runs every check and publishes nothing. It works on a `private: true`
  package, so a package that never reaches a registry can still be checked by the rules it would
  face. `--verify-only` is the same operation for scripts that can only pass flags.
- **`--strict`** treats warnings as errors. It never makes an already-applied repair fatal.

### Changed

- **The download is 46% smaller**: 63.2 kB to 34.0 kB, and 154.0 kB to 62.7 kB installed.
  `dist/cli.js` is minified with function and class names kept, so a stack trace from an unexpected
  failure still names the function that threw.
- **Guards that used to abort on the spot now report instead** — a packed credential,
  `node_modules`, `.git`, a test tree, a lockfile, a registry URL carrying a password, a
  `workspace:` spec. They are findings beside the rest now. Nothing is weaker for it:
  `secret-file` and `internal-file` still stop the publish and no flag waives them. A packed
  credential is now also told to **rotate** it, because the key was written into a tarball on the
  build machine whether or not anything was published.
- **A declared path is checked by the resolver that reads its field.** An empty `main` is the unset
  field npm and Node treat it as; `module` and a string `browser` may name a directory or omit the
  extension; a target ending in `/` names a directory. `bin` keeps none of that tolerance, because
  npm symlinks the exact path it is given. Measured against 5192 installed packages, the previous
  exact-name check refused 373 that install and resolve — every `@types/*` package, every `@aws-sdk`
  client, `svelte`, `vite`. A declared path nothing a consumer resolves can reach — `sideEffects`,
  the object form of `browser`, an internal `#` import, a `*` pattern matching no packed file — now
  reports as `declared-path-inert` instead of stopping the publish; `--strict` still refuses it.
- **Unrecognised manifest fields report as `[warning] unrecognized-field`**, in severity order with
  everything else, instead of an unlabelled paragraph printed before the tarball existed. `--strict`
  now promotes them like any other warning; acknowledge them with
  `"publish-clean": { "keepFields": [...] }`, which the message prints for you.
- **Every run ends by saying what it decided.** `publish-clean: no findings.`, or
  `publish-clean: N findings above, none of which stops a publish.` A silent pass could not be
  told apart from a crash.
- **Checking a package no longer needs npm installed.** npm is started at the upload rather than at
  startup, so `verify` and `--dry-run` never start it. A publish still refuses when npm is missing
  or cannot be executed, before anything is uploaded.
- **A directory outside any Git repository no longer fails the run.** There is no commit there for a
  tree to differ from, so the check reports that it was skipped and the run continues. It used to
  abort with a raw `git exited with 128`. `--no-git-checks` is unchanged, and is still the way to
  publish from a repository with uncommitted changes.

### Fixed

- **A package with a long path publishes under pnpm 12.** A path too long for a plain tar name is
  carried by a header in front of the entry it belongs to; pnpm 11 wrote a PAX header there, pnpm 12
  writes a GNU long-name one, which this tool refused outright. Such names are now read and judged
  by the rules PAX names already passed — still refused when the name renames a member onto
  `package/package.json`, escapes the package directory, or collides with another entry.
- **`preferUnplugged` is no longer reported as an unrecognised field.** Yarn reads it from an
  installed dependency's own manifest to decide whether that package must be unzipped to work, so a
  consumer's installer resolves it. The report used to advise stripping it, which changes how the
  package installs for every Yarn user, and `--strict` refused the package outright.
- **Failures name their cause instead of printing a stack.** A mistyped flag is answered with the
  flags that exist; a missing `package.json` is no longer reported as a syntax error; an unwritable
  `TMPDIR`, a full disk and an unusable `--tarball-out` each say what failed and where; an
  unreadable manifest names the file, which pnpm 12 does not; and a pnpm binary that is present but
  not executable says so and says to allow pnpm's install script. A stack trace now means a defect
  in this tool, which is the one case where the frames are the report.

## [0.9.1] - 2026-09-08

### Added

- Set `publish-clean.validateArtifact` to an executable and arguments to validate the exact cleaned tarball before retention or upload, including preview modes. Failure or changed archive bytes prevents publication. Commands run without shell interpretation.

### Fixed

- Releases now wait for Linux checks, the dependency audit and Windows checks on the
  tagged commit before publishing. CI and release verification share the same workflow.
- Windows release checks exercise validator argument safety and uploaded byte identity. The consumer-install smoke test uses the ordinary child-process hang deadline rather than a five-second cutoff.

## [0.8.0] - 2026-09-08

### Changed

- **Publication arguments are restricted.** Arguments after `--` must be publication
  options listed by `--help`. Additional package operands, workspace selectors, unknown
  flags and values starting with `-` are rejected so npm cannot select an unchecked
  package. Use `./` for a filename beginning with `-`.
- **Consumer lifecycle helpers survive cleaning.** If `preinstall`, `install`,
  `postinstall`, `prepare` or `uninstall` exists, the complete scripts block is retained;
  a hook such as `postinstall: "npm run setup"` no longer loses `setup`. Packages without
  these hooks still have their development scripts removed.
- **Registry URLs cannot contain credentials.** Explicit and configured destinations,
  including scoped registries in the packed manifest, reject usernames and passwords.
  Put authentication in npm configuration instead; rejected URL credentials are not
  included in the error message or cause.
- **Malformed configuration fails locally.** The `publish-clean` block must be an object,
  boolean settings must be booleans, registry settings must be absolute HTTP(S) URLs, and
  `files` entries must be non-empty strings. `devFields` also refuses consumer-resolved
  ecosystem fields such as `svelte`, `react-native`, `style` and `unpkg`.
- **Preview checks stop before publication preflight.** `--dry-run` and `--guard-only`
  validate the artifact without checking provenance toolchain requirements or GitHub
  publisher identity. A preview does not establish that a subsequent upload can succeed.

### Fixed

- **Long archive paths cannot bypass file guards.** Scanning resolves USTAR prefixes and
  PAX paths and sizes. Ambiguous aliases, duplicate paths and malformed archive metadata
  are refused; rewriting verifies entry order, metadata and non-manifest bytes as well
  as the file set.
- **The selected registry wins for scoped packages.** `--registry` and the configured
  default pin both general and package-scope destinations, overriding a conflicting
  scoped npm setting.
- **Provenance preflight follows effective configuration.** Explicit boolean values and
  repeated flags follow npm precedence, including `--no-provenance` overriding manifest
  provenance. When neither selects it, npm resolves the environment and npmrc setting.
  GitHub OIDC authentication still requires the trusted-publishing runtime.
- **Pack hooks cannot bypass `private: true`.** The packed manifest is checked before the
  cleaner removes the field, including when a lifecycle script changed it during packing.
- **Declared paths follow their consumer semantics.** Checks handle CommonJS extension
  and index lookup, declaration-file suffixes, export/import condition order, array
  fallbacks, URL targets and subpath patterns. Literal stars are not treated as globs in
  ordinary entry paths, and `sideEffects` globs may legitimately match no shipped file.
- **Local dependencies must travel with the artifact.** Shipped vendor packages remain
  supported; missing or outside local targets and unresolved monorepo protocols are
  refused. Ordinary remote URLs containing protocol-like text are no longer misclassified.
- **Verbose packing and cancellation no longer strand the pipeline.** Lifecycle output
  streams without the metadata capture limit. Interrupts terminate packing process trees
  and wait before removing temporary files; npm retains terminal access for OTP prompts.
- **Diagnostics distinguish retained content from successful publication.** Unknown fields
  are reported as retained, including during previews. File and field names are quoted so
  embedded newlines cannot forge additional report entries.
- **Release repairs require artifact identity.** Tag identity and release notes are checked
  before upload. Reruns verify registry integrity before attesting or replacing assets,
  distinguish registry failures from an unpublished version, and refresh an existing
  GitHub release description from the tagged changelog section.

## [0.7.3] - 2026-08-11

### Added

- `dist/cli.js` includes an SPDX licence comment, package name, version and homepage,
  read from `package.json` at build time. Readers and licence scanners can identify the
  installed file without its manifest.

## [0.7.2] - 2026-08-11

### Changed

- Disabled code compression in `dist/cli.js` to make the installed CLI easier to audit.
  Keeping names and comments alone still allowed the compressor to rewrite control flow
  that comments described. Normal bundling and TypeScript removal still apply.
  The change added 1,157 gzipped bytes to this release.

## [0.7.1] - 2026-08-11

### Fixed

- **Windows: an argument `cmd.exe` would interpret is now refused instead of being passed
  through.** 0.7.0 began running `pnpm` and `npm` through `cmd.exe`, which parses the command
  line a second time, and Node quotes an argument only when it holds a space, tab or quote. A
  path or a forwarded argument containing `& | < > ^ %` therefore reached `cmd` unquoted:
  publishing from `C:\R&D\pkg` would have packed a truncated path and run the remainder as a
  separate command. Only 0.7.0 is affected, and only on Windows. Such an argument now stops the
  run and is named in the error.
- **Tar header checksums are verified.** The rewriter computes one for the block it authors and
  nothing checked it, so that computation vouched for itself — and an archive whose headers some
  extractors reject could have shipped with every guard green.
- **The provenance floor is checked against the Node that runs npm**, rather than the runtime
  running this tool. `npm` is a `#!/usr/bin/env node` script, so those differ whenever the two
  are not the same install — and entirely under Bun, where `process.versions.node` is a
  compatibility claim about a runtime that never executes npm.

### Changed

- **Running under Bun packs a smaller tarball**, 0.17–0.28% on real packages, with a
  byte-identical archive inside; Bun carries libdeflate where Node has zlib. The README explains
  how to get it — and why `bun publish-clean`, `bun run publish-clean` and `bunx publish-clean`
  all silently run Node instead.

## [0.7.0] - 2026-08-11

### Added

- **Windows works.** `pnpm` and `npm` on Windows are `.cmd` shims, which Node cannot launch
  directly, so every run failed claiming the package manager was "not available in PATH" —
  about a package manager that was installed and working. Both are now run through `cmd.exe`,
  and a Windows job in CI publishes this package in dry-run mode on every push, so the
  basic pack-and-check path is exercised on Windows.

### Fixed

- **A truncated tarball is now refused.** An archive that ended exactly on an entry boundary,
  with its end-of-archive marker missing, was read as one that simply stopped: every entry in
  it parses cleanly, so nothing in the walk could feel the truncation. Publishing then wrote
  an archive with no terminator at all.

### Changed

- **A release now publishes only after the Linux check lane passes in CI**, on the tagged
  commit, in a job that holds no credentials. A hand-made tag, or any local bypass, could
  previously reach the registry — and an npm version is permanent.

## [0.6.0] - 2026-08-11

### Changed

- **`--skip-file-check` no longer disables the artifact scan.** It waived two unrelated
  policies at once: the `files`-array requirement, a manifest convention some packages do not
  follow, and the scan that keeps tests, CI config, lockfiles and `tsconfig` out of the
  published tarball. Waiving the convention now leaves the scan armed. Use the new
  `--allow-suspicious` (or `"allowSuspicious": true`) if you relied on the old combined
  behaviour.
- **`tar` is no longer required.** The tool reads and rewrites the archive itself, so `pnpm`
  and `npm` are the only executables it needs. This also removes four subprocesses and four
  decompressions per run, detects a truncated archive instead of reading it as one that
  simply ended, and handles a filename containing a newline, which a line-based `tar tzf`
  listing cannot express.
- **The published tarball is compressed at gzip's maximum level.** Measured on this package:
  26,440 bytes, against 26,699 at the previous default and 26,500 as pnpm packed it. Output
  stays byte-identical across runs, so a re-run still reproduces a published artifact exactly.
- **`engines.node` is now `>=22.0.0`.** 0.5.0 declared the provenance floor, 22.14, and so
  refused to install for anyone publishing to a private registry with a token — a case this
  tool supports. Provenance still requires 22.14, checked at the moment it is requested.
- **An unknown key under `"publish-clean"` in `package.json` is now an error**, as is a
  `devFields`/`keepFields` value that is not an array of strings, or a field listed in both.
  A typo such as `devFeilds` previously did nothing at all and published the field it was
  written to strip.

### Added

- `--version` / `-v`, and a `--help` that documents every flag and every manifest config key.
- `--allow-suspicious`, the artifact-scan half of the old `--skip-file-check`.

### Fixed

- A failing `git status` now reports what git said. It was replaced with "Unable to verify
  source git status", which hid the difference between "this is not a git repository" and
  "git is not installed" — and did not mention `--no-git-checks`.

## [0.5.0] - 2026-08-11

### Changed

- `--dry-run` now prints the file list and the cleaned `package.json` instead of leaving an
  extracted directory behind and printing its path. **Anything parsing `[dry-run] Extracted
  package at:` or `[dry-run] Final tarball at:` out of stdout must switch to `--tarball-out
  DIR`**, which writes the published bytes into a directory you name and own. No mode keeps a
  temporary tree now, on success or on failure; every previous dry-run leaked one.
- Node.js 22.14 or newer is required. That is the floor npm enforces before it will sign a
  publish, so below it `--provenance` cannot work at all.

### Fixed

- `npm publish` runs from your package directory, so a project `.npmrc` is honoured. It
  previously ran with the working directory inside a temporary tree; npm resolves its config
  from the nearest ancestor holding a `package.json`, found none, and silently used defaults
  instead of the registry and settings your project declared.
- The tarball rewriter refuses GNU long-name entries. A path longer than 100 bytes is stored
  in a preceding long-name entry, which can rename another archive member onto
  `package/package.json` — the one file that decides what every consumer resolves.
- The file set of the rewritten tarball is checked against the packed one again, by reading
  both with `tar`. 0.4.0 shipped with no invariant on the rewriter's output at all.

## [0.4.0](https://github.com/Anizoptera/publish-clean/compare/v0.3.0...v0.4.0) (2026-08-11)


### Features

* pack once and rewrite the manifest in place, dropping the second pack ([f9a24ec](https://github.com/Anizoptera/publish-clean/commit/f9a24ec4c3e7d3e3b55eebe006c27483d4db273e))

  The published artifact is the tarball `pnpm pack` produced, with only its
  `package.json` member replaced. Previously the cleaned directory was packed a
  second time by npm, which re-derived the file set from `files` — the field
  cleaning removes — and so fell back to `.gitignore`/`.npmignore` for exclusion.
  A package that shipped an ignore file excluding another of its own shipped
  files could therefore lose it.

  Three consequences for what you publish. `files` is now stripped from the
  published manifest, since nothing re-selects after packing and the registry
  deletes the field anyway. The artifact keeps pnpm's normalised entry metadata
  instead of the build machine's user and group names. And no lifecycle script
  runs after the pack, because npm skips `prepack`/`postpack` when it is handed
  a tarball rather than a directory.

  Provenance is unaffected: npm uploads the tarball byte for byte and signs the
  digest of exactly those bytes.


### Internal changes

* make the rules module actually pure, and cover what nothing covered ([3f3a9d3](https://github.com/Anizoptera/publish-clean/commit/3f3a9d3311218acd71bd04069ed952548ea6b372))
* move registry pinning into the rules, where it can be tested ([a52f922](https://github.com/Anizoptera/publish-clean/commit/a52f922f7a774bded0b3bfe16221fc1115084a89))
* separate the publish rules from the effects that run them ([3ec88cd](https://github.com/Anizoptera/publish-clean/commit/3ec88cd6a5495a94c039d240c629d4df0cbf67ac))

## [0.3.0](https://github.com/Anizoptera/publish-clean/compare/v0.2.0...v0.3.0) (2026-08-11)


### Features

* **cli:** refuse to publish a manifest that lost a field consumers read ([b5ff004](https://github.com/Anizoptera/publish-clean/commit/b5ff0048a442d2632cb1cb3e772db865a293f99d))
* **cli:** report manifest fields nobody recognises instead of shipping them silently ([7f41118](https://github.com/Anizoptera/publish-clean/commit/7f41118484fdd728d8b379b2f129e76eec5a5f1d))


### Bug Fixes

* **build:** stop requiring an optional peer that nothing installs ([9a50594](https://github.com/Anizoptera/publish-clean/commit/9a50594fd8899929a8e34e61be8a13581a757efd))
* catch private keys the leak guard was letting through ([9b3008b](https://github.com/Anizoptera/publish-clean/commit/9b3008b9a964ddb44cc26d005527e41f98ac0bb5))
* **cli:** say what a required tool actually did instead of guessing ([95397f6](https://github.com/Anizoptera/publish-clean/commit/95397f610b0005c42d6fd3680f8a6eb682364b34))
* correct the Yarn claim, which was inferred and is false ([594339a](https://github.com/Anizoptera/publish-clean/commit/594339ad41021c40cbc7895b1729bf6203d06ab7))
* correct what the docs and the advisory claim about Bun and Yarn ([9b42660](https://github.com/Anizoptera/publish-clean/commit/9b4266040808ae711dc51df2891dcb98db65188d))
* **release:** stop dropping user-visible changes from the changelog ([b31954f](https://github.com/Anizoptera/publish-clean/commit/b31954fccdb946c2f81842f0b5a88e6c7ef8e08f))
* **release:** unblock publishing from generated files and package-manager drift ([2626743](https://github.com/Anizoptera/publish-clean/commit/2626743c68bea33fbbba904b658749c06a1e2cdf))


### Internal changes

* **cli:** drop the pnpm.overrides check, which guarded nothing ([689f7b2](https://github.com/Anizoptera/publish-clean/commit/689f7b259e6415e93f6acb7d35a21ced7067a740))
* **cli:** stream publish output, and fold the two path collectors into one ([9446fb7](https://github.com/Anizoptera/publish-clean/commit/9446fb7d599d55de5f119c9d27c5fbe3906afdc1))
* keep the packer evidence in one place ([e379fd4](https://github.com/Anizoptera/publish-clean/commit/e379fd497d0a82f66def80722619404aff6e158b))
* **release:** make the publish job minimal and repeatable ([12f9bad](https://github.com/Anizoptera/publish-clean/commit/12f9bad339d3ea5ff024a2b466dcc803da904346))

## [0.2.0](https://github.com/Anizoptera/publish-clean/compare/v0.1.0...v0.2.0) (2026-08-10)


### Features

* create public publish-clean package ([5cc9879](https://github.com/Anizoptera/publish-clean/commit/5cc9879cfe794299b41733910f93b1d53bf97dc2))
* retain the published tarball and attest it in the release pipeline ([4f79788](https://github.com/Anizoptera/publish-clean/commit/4f79788c1807fd6b67c1efb611b536c63c96a3ef))


### Bug Fixes

* harden publish-clean CLI guards ([9401836](https://github.com/Anizoptera/publish-clean/commit/940183612c43d4a5a184a38df7ad860a177a28db))
* locate packed tarballs on disk instead of parsing packer stdout ([3c9f778](https://github.com/Anizoptera/publish-clean/commit/3c9f778e95a59190968efbbc38fbdc3142226fd1))
* make cli build reproducible ([6fe8fff](https://github.com/Anizoptera/publish-clean/commit/6fe8fff46c8a1b067b0f2d422136153b3b006f5e))
* publish cleaned npm tarballs ([1bf9a2e](https://github.com/Anizoptera/publish-clean/commit/1bf9a2eb73c3061c6608d9b9b7f24f7535d5cd3c))
* stop tracking built cli artifact ([ba822da](https://github.com/Anizoptera/publish-clean/commit/ba822dabd49ecba68356c957bca3411c47d0b34a))
