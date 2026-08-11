# Changelog

Notable changes per release, newest first. This file is the source of the GitHub Release
notes: the section for a version is published verbatim when its tag is pushed.

## [0.7.2] - 2026-08-11

### Changed

- **The published `dist/cli.js` is no longer compressed, so you can audit the file you install.**
  It now reads statement for statement as the repository source does, types erased and nothing
  else, and a diff against `src/` is a real check. Previously `mangle: false` kept the names and
  comments while the compressor still rewrote the code underneath them — `const` to `let`, `===`
  to `==`, `if (a) b()` to `a && b()`, an early return into a nested branch — leaving comments
  describing control flow that no longer matched. This tool runs on your publish path and handles
  registry credentials, which is a poor place to ask for trust in bytes nobody can read. The file
  grows 1,157 gzipped bytes, downloaded once per developer.

## [0.7.1] - 2026-08-11

### Fixed

- **Windows: an argument `cmd.exe` would interpret is now refused instead of being passed
  through.** 0.7.0 began running `pnpm` and `npm` through `cmd.exe`, which parses the command
  line a second time, and Node quotes an argument only when it holds a space, tab or quote. A
  path or a forwarded argument containing `& | < > ^ %` therefore reached `cmd` unquoted:
  publishing from `C:\R&D\pkg` would have packed a truncated path and run the remainder as a
  separate command. Only 0.7.0 is affected, and only on Windows. Such an argument now stops the
  run and is named; escaping them correctly is worth doing when a real path needs it.
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
  platform is verified rather than assumed.

### Fixed

- **A truncated tarball is now refused.** An archive that ended exactly on an entry boundary,
  with its end-of-archive marker missing, was read as one that simply stopped: every entry in
  it parses cleanly, so nothing in the walk could feel the truncation. Publishing then wrote
  an archive with no terminator at all.

### Changed

- **A release now publishes only after the full check lane passes in CI**, on the tagged
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
