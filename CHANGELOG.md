# Changelog

Notable changes per release, newest first. This file is the source of the GitHub Release
notes: the section for a version is published verbatim when its tag is pushed.

## Unreleased

### Added

- **`publish-clean verify` checks a package without publishing it.** It runs every rule the
  publish path runs and skips exactly one guard, so it works on a `private: true` package that
  publishing still refuses. `--verify-only` is the same operation for scripts that can only pass
  flags; `--guard-only` keeps working as a deprecated alias and now says so.
- **`exports` and `imports` are verified and repaired.** The map is flattened into the resolution
  it produces for every possible consumer, and rewritten only when the result is provably
  identical: a condition that repeats what a later key already yields is dropped,
  `{"default": "./x.js"}` collapses, and keys whose order a measured constraint forces are
  ordered. Every repair is reported, applies only to the published manifest, and never touches
  your source. A repair never stops the run. `--no-heal`, or `"publish-clean": { "heal": false }`,
  reports without rewriting. An order that cannot be repaired, because reordering it would change
  what some consumer resolves, is reported instead — and refuses the publish only where a consumer
  really loses a target: a runtime-specific build shadowed by a generic one. A misplaced `types`
  is a warning, because a checker reaching the JavaScript target reads the declarations beside it,
  and `--strict` still refuses over it.
- **Defects that cannot be repaired without guessing are reported.** A `types` condition resolving
  to something that is not a declaration file and has none beside it either — a checker falls back
  from a JavaScript target to the declaration shipped next to it, and reads a TypeScript source
  directly — a `require` condition resolving to an ES
  module, a branch no consumer can reach, a consumer no branch serves, a condition no measured
  consumer activates, a fallback array, a shebang ending in CR — which refuses the publish only in a
  `bin` entry, because nothing else is reached through execve — and a `bin` entry with no
  shebang at all — the installed command is a symlink the kernel resolves through that line, and npm
  reads the same line to pick the interpreter for its Windows shim, so the command runs on no
  platform without it. A `bin` file holding a NUL byte is left alone: compiled binaries are executed
  directly and need no shebang.
- **Publication stops when a packed name would not survive extraction.** Two files whose names
  differ only in letter case or Unicode form become ONE file on macOS and Windows, so the install
  reports success and the package is silently missing a file. A name Windows cannot create — a
  reserved device name like `aux.js` in any path component, a character such as `:` or `?`, a
  trailing dot or space — fails the install outright there. Both are invisible on the machine that
  built the package. If the package genuinely does not run on Windows, declare `"os": ["!win32"]`
  and the Windows half stops applying; a path component over 255 bytes is reported regardless,
  because no filesystem here accepts one.
- **`--strict` treats warnings as errors.** It never makes an already-applied repair fatal.
- **Publication stops when the package imports itself through a subpath its own `exports` does not
  expose.** Self-reference resolves through `exports` like anyone else's import, so shipping the
  file is not enough — and it cannot be seen from the source tree, where the same import resolves
  by path. A consumer's type checker reports `TS2307` inside a file they cannot edit, or, under the
  common `skipLibCheck: true`, silently types it `any`. The fix is to export the subpath or make
  the import relative; the message prints both.

### Changed

- **The published package is 43% smaller.** `dist/cli.js` is now minified, taking the download
  from 59.6 kB to 33.7 kB and the installed file from 138.5 kB to 58.2 kB. Function and class
  names are deliberately kept, so a stack trace from an unexpected failure still names the
  function that threw and stays usable in a bug report. Behaviour is unchanged; the transforms
  that could have altered it are off.

- **A package that resolves correctly is no longer refused over a path only its bundler reads.**
  Every declared path is checked by the resolver that actually reads that field. An empty `main` is
  the unset field npm and Node treat it as; `module` and a string `browser` may name a directory or
  omit the extension, exactly like `main`; a target ending in `/` names a directory rather than a
  file, which is how `@babel/runtime` still serves its Node 12–16 consumers. `bin` keeps none of
  that tolerance, because npm symlinks the exact path it is given. Measured against 5192 installed
  packages, the previous exact-name check refused 373 that install and resolve, among them every
  `@types/*` package, every `@aws-sdk` client, `@babel/runtime`, `svelte` and `vite`.
  A declared path nothing a consumer resolves can reach — `sideEffects`, the object form of
  `browser`, an internal `#` import, or a `*` pattern matching no packed file — is now reported as
  `declared-path-inert` rather than stopping the publish, because it marks or replaces nothing and
  so is stale rather than broken; `--strict` still refuses over it. An exact path a consumer does
  resolve stops the run as before, and so does an archive carrying nothing the manifest declares at
  all, which is the unpacked-build case the stop exists for.

- **One run now tells you everything wrong with your package.** Four checks used to stop at the
  first thing they found, so a package with several defects cost one run per defect: a
  credential in a `publishConfig` registry URL and a `workspace:` dependency spec now report as
  findings (`registry-credentials`, `registry-not-a-url`, `monorepo-only-spec`) alongside the
  whole artifact scan, and `private: true`, uncommitted changes and a missing `files` array are
  refused together before packing. Every one still refuses the publish; none is waivable that was
  not waivable before.

- **Every run now ends by saying what it decided**, instead of going silent when it passes.
  `publish-clean: no findings.`, or `N findings above, none of which stops a publish.` A report
  that printed warnings and then stopped could not be told apart from one that crashed.

- **Unrecognised manifest fields are reported like every other finding**, as
  `[warning] unrecognized-field`, in severity order with the rest. It used to print as an
  unlabelled paragraph before the tarball existed — no rule id to grep or silence, no severity to
  rank it by, and positioned above findings more serious than itself. The advice is unchanged, and
  it still never stops a publish on its own. **`--strict` now promotes it like any other warning**,
  so a strict run refuses a package carrying fields nobody has classified; acknowledge them with
  `"publish-clean": { "keepFields": [...] }`, which the message prints for you.

- **A report now says how bad a defect is and whether it was repaired as two separate facts.**
  There was a third severity, `[healed]`, which made a repaired breakage and a harmless stray file
  read alike. A repair corrects the published artifact and never your source, so the defect keeps
  the severity it had — a repaired breakage prints `[error]` — and the repair is stated in words
  beside it. Whether the run stops is unchanged: a repaired finding never stops it, with or
  without `--strict`. Anything parsing the `[healed]` label must read the message instead.

- **Publication stops when the tarball holds a file nothing in the package reaches** — no entry
  point, no import from a reached file, no script. Documentation, licences, declarations, source
  maps, native binaries, assets and nested `package.json` files are exempt by nature. Declare the
  rest with `"publish-clean": { "allowUnreferenced": ["assets"] }`, which the error message prints
  for you; prefixes match whole subtrees. The check runs only when `exports` closes the package,
  because without that field every shipped path is importable and nothing is dead.

- **Checking a package no longer needs npm installed.** npm exists here to upload a tarball, so
  it is now started at the upload rather than at startup: `verify` and `--dry-run` stop before
  that point and never start it. Measured on this machine, dropping that probe took `verify` from
  0.14s to 0.07s and removed its spread — the probe was the largest single cost in the run. A
  publish still refuses when npm is missing or cannot be executed, before anything is uploaded.

- **A package directory that is not a Git repository no longer fails the run.** It used to abort
  with a raw `git exited with 128`, which made `--no-git-checks` — documented as allowing a dirty
  working tree — the only way to publish a directory that has no repository at all. There is no
  commit there for a tree to differ from, so the check now reports that it was skipped and the run
  continues. An absent `git` and an unreadable index behave the same way, for the same reason, and
  the warning quotes git's own explanation of which it was. Use `--no-git-checks` for what it
  says: a repository whose tree is dirty, which still stops the run.

- **Forbidden content in the tarball is reported with everything else, in one run.** Packing a
  key, a `node_modules`, a `.git`, a test tree or a lockfile used to stop the run on the spot, so
  the rest of the report was never produced: an author fixed one problem per round trip without
  knowing how many were left. All of it now reports as findings — `secret-file`, `internal-file`,
  `suspicious-file` — beside the export, reachability and packed-name rules, and a run that is
  about to stop still prints everything it found.

  Nothing is weaker for it. `secret-file` and `internal-file` are `harm`: no flag reaches them,
  `--strict` has nothing to add, and they are never repaired for you. `suspicious-file` is the one
  judgement call, waived by `--allow-suspicious` or `"publish-clean": { "allowSuspicious": true }`
  and by nothing else.

  A packed credential is now also told to **rotate** it. The old message named the files and
  advised fixing the `files` array, which reads as the whole repair and is not: the key was
  written into a tarball on the build machine, so it left your repository whether or not anything
  was published. `node_modules` and `.git` carry no credential of their own and still get only the
  `files` advice. Measured over 2485 published packages in one machine's install cache, a single
  package fires these rules at all — so the message is most of what they are worth.

### Fixed

- **`preferUnplugged` is no longer reported as an unrecognised field.** Yarn reads it from an
  installed dependency's own manifest to decide whether that package must be unzipped to work, so
  it is a field a consumer's installer resolves, not noise. The report used to advise stripping it
  — which would change how the package installs for everyone using Yarn — and `--strict` refused
  the package outright.
- **A temp directory that cannot be created is explained rather than thrown as a stack.** A full
  disk or an unwritable `TMPDIR` — the ordinary shape of this on a CI runner — used to surface as an
  `mkdtemp` stack, which reads as a defect in publish-clean. It now names the directory and says
  what it is needed for.
- **An unusable `--tarball-out` directory is named instead of failing as a stack trace.** A typo
  used to surface as a raw `mkdir` stack after the run had already printed its findings verdict,
  which reads as a defect in publish-clean rather than in the command that was typed. It still
  surfaces only after the pack: the destination is deliberately not created until the artifact has
  passed every check, so nothing appears at the path you named for bytes that failed validation.
- **A mistyped flag is answered with the flags that exist.** It used to escape as Node's own
  `ERR_PARSE_ARGS_UNKNOWN_OPTION`: a stack trace through `node:internal` that reads as a defect in
  this tool, carrying advice to move the argument after `--` — where this CLI forwards it to
  `npm publish`, the one step nobody can take back. The reply now names the flag, lists every
  accepted one, and points at `--help`.
- **Running from the wrong directory no longer reports a syntax error.** A missing `package.json`
  and a malformed one shared the message "Unable to parse JSON file", so the ordinary first
  mistake sent its author hunting for a comma in a file that does not exist. A file that cannot be
  read now says so and names the fix; a file that cannot be parsed still reports where.
- **An error no longer buries its own explanation in a stack trace.** The cause of a reported
  failure was printed as an object, so its stack and properties followed it: a malformed
  `package.json` produced nine lines of which two carried information. The cause still prints,
  because it holds the one detail the message cannot — where the JSON syntax broke, which errno a
  spawn returned — but the frames behind it belong to this tool rather than to your package. An
  unexpected internal error still prints in full, since there the stack is the report.

- **A package with a long path can be published under pnpm 12.** A path too long for a plain tar
  name is carried by a header in front of the entry it belongs to; pnpm 11 wrote a PAX header
  there, pnpm 12 writes a GNU long-name one. This tool refused GNU long names outright, so under
  pnpm 12 any package holding a path over roughly 100 bytes stopped with `Tarball uses GNU
  long-name entries`. The name is now read and judged by the rules PAX names already passed: it
  is still refused when it renames a member onto `package/package.json`, escapes the package
  directory, or collides with another entry.
- **An unreadable `package.json` names the file again.** The message came from whichever package
  manager happened to parse it first, and pnpm 12 reports the syntax error without saying which
  file it was in. The manifest is read before any package manager is started now.
- **A package manager that is present but cannot be executed says so, and says what to do about
  it.** It surfaced as a bare `spawn ENOEXEC` and a stack trace naming neither the tool nor a
  repair. Installing pnpm 12 without running its install script — Bun's default, and what
  `--ignore-scripts` does — leaves a placeholder at its command instead of the real binary, and
  this tool cannot start it. Allow pnpm's build scripts and reinstall; under Bun that means
  listing `pnpm` in `trustedDependencies`.

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
