Repair the audited publication pipeline without changing which files pnpm selects or publishing anything remotely.

## Authority and scope

Art: “Go on, do all the improvements”; “Consider this temporary ledger file as your plan slash SOP.” This file owns the current tasks and unresolved rulings. The baseline is `792beb0cce1d8a8a57a3ac9f04abfb8a873299df`; the initial working tree was clean. Audit findings are hypotheses until their owning source and regression are checked during implementation.

Art's existing project rulings: runtime dependency-free; pnpm packs once; only manifest content changes; final on-disk bytes drive guards; npm uploads that tarball; unknown manifest fields survive; critical artifact checks cannot be waived; release verification has no publication credentials. No release, remote upload, or global guidance edit is authorized.

Art's latest verification ruling supersedes the local full-check-before-each-commit cadence: use targeted checks on complete changes, commit each verified part, run the complete routine lane at final integration. Tests must distinguish material failures, use readiness signals, and finish within the requested feedback budgets. Full routine lane must remain below five minutes; target thirty seconds. Keep one implementation phase active. Retain every unfinished task; compress finished phases into evidence summaries.

## Needs ruling

- [ ] R1 — Restrict forwarded npm options to documented publication options, rejecting artifact/workspace selectors. Requested because `--workspaces .` demonstrably uploads an unchecked workspace. Existing arbitrary forwarding is a public promise; proposed restriction is pending Art's answer.
- [ ] R2 — Preserve the complete scripts block when consumer lifecycle hooks exist; otherwise strip development scripts. Fixes helper-script deletion while retaining more manifest content. Pending Art's answer.
- [ ] R4 — Reject credential-bearing registry URLs and require npm configuration for authentication. A fixture URL with user:fixture-secret appears verbatim in both emitted registry fields. Pending Art's ruling because rejecting accepted URLs or moving their credentials changes the public contract. On approval, cover explicit/configured registry URLs and the final packed manifest; prevent credential values from appearing in diagnostics.

## Derived work, ordered by harm and dependency

- [x] Rewrite the owned temporary tarball directly, removing a directory creation and second artifact path while retaining final disk readback. Typecheck/build and 55 CLI/archive/actual-upload regressions passed in 2.37s.
- [ ] Restore the explicit pnpm-only requirement weakened by the documentation compression; keep the measured bundling limitation and rationale link.

- [x] Removed the help-parser subprocess matrix, order-insensitive manifest comparator and obsolete subprocess-error adapter. Configuration and option parsing moved intact to their own modules. Isolated CLI cases run concurrently; their lane with manifest tests passed in 2.06s. Typecheck caught and corrected a Vitest modifier-order mistake during this move.

- [x] Archive interpretation and preservation — effective USTAR/PAX paths and byte-counted records; size overrides; malformed tails and alias/duplicate rejection; final-readback raw entry/order/metadata guard. Verified: typecheck and build; `bunx vitest run test/tarball.test.ts test/cli.test.ts` passed 50 tests in 2.11s, including real pnpm safe/secret long paths and independent tar readback. Synthetic framing test corrected from a valid nine-byte record to a malformed eight-byte one; this was a test expectation error, not a parser fix.
- [ ] Publication identity and destination — Basis: npm must upload the checked artifact to the requested registry.
  - [ ] Implement R1 after ruling; test supported values and hostile selectors through actual npm and a loopback registry.
  - [x] Explicit registry pins both the general and package-scope setting in the manifest and npm invocation. Actual loopback PUT matched the retained bytes and selected /chosen/ despite scoped /wrong/ configuration (605ms test). The fixture needed an auth key for the exact registry path; a host-only key did not authenticate npm’s preflight. Conflicting forwarded registry options remain tied to R1.
  - [x] Refuse a packed private manifest before stripping, including lifecycle mutation.
  - [x] Bind tool/version probes to the package cwd, bound them, and reuse their results.
  - [ ] Parse effective provenance intent and distinguish artifact preview from publication preflight.
  - [ ] Verify the completed publication surface, update its consumer documentation and commit.
- [ ] Manifest and consumer behavior — basis: cleaning must preserve useful consumer behavior and reject broken package references.
  - [ ] Implement R2 after ruling; exercise a real lifecycle calling a retained helper.
  - [x] Reject malformed configuration objects, boolean/list values and registry URLs; validate files entries. Manifest regression lane passed 51 tests.
  - [ ] Complete script removal under R2. Consumer-resolved ecosystem fields are now protected; their regression cases pass.
  - [x] Local dependency experiment: npm installed a tarball carrying file:./vendor and Node required its consumer as 42. Therefore keep shipped vendor directories/tarballs; reject absent/outside local targets and avoid protocol substrings in ordinary URLs. Regression cases preserve these distinctions.
  - [x] Declared-path validation is wired to the final manifest. Node probes cover extensionless/directory main, URL targets, invalid exports and array fallbacks; wildcard checks require matching shipped targets. Node falsified the proposed nested-package main reader, so that reader and callback were removed; its rejection case remains. Typecheck/build and the artifact/manifest/resolution/built-CLI lane passed 125 tests in 4.86s. The existing complete-artifact fixture now also exercises pnpm consuming publishConfig.main and an extensionless published main. Loss detection compares pnpm's resolved manifest, and one serialized manifest string is reused for writing, comparison and display.
  - [x] Drive all manifest guards from the final readback and preserve condition ordering. Additional adversarial cases exposed two interpretation errors: a PAX header named package/package.json was mistaken for the member, and Windows local dependency spellings could evade the portability guard. Both failed before repair; typecheck and 83 archive/manifest tests pass after it.
  - [ ] Verify the completed manifest surface after R2 and commit. Node exposed a false pass introduced by the new matcher: main: "*.js" is literal. Webpack's selector contract exposed the opposite error for sideEffects globs: an empty match is valid. Both regressions failed before repair; the path lane passes 51 cases in 95ms. Consumer documentation and inline rationale now distinguish these semantics.
- [ ] Process lifetime and diagnostics — Basis: ordinary verbose builds and cancellation must not break or leak temporary artifacts.
  - [x] Stream pack output without the synchronous capture buffer limit; retain useful failure context without unbounded accumulation.
  - [x] Own cancellation, child settlement and temporary-directory cleanup; test readiness using lifecycle markers, including a descendant ignoring SIGTERM. The cancellation regression initially also counted Node’s compile-cache directory; inspect only directories this CLI owns.
  - [x] Windows rejects line-break command separators. Its CI job now runs real child cancellation and the existing package dry-run under a five-minute limit; actual Windows execution remains unobserved locally. `actions-up --yes` found no action updates.
  - [x] Expected refusals stay concise; underlying causes and unexpected errors retain their stack. Filenames and unknown fields are JSON-escaped. Removed the obsolete error-output adapter and unreachable git wrapper. Repeated SIGTERM preserves cleanup. POSIX publication retains the caller's terminal group, independently checked with ps; pack lifecycles retain group cancellation. Typecheck/build and 68 command/CLI/registry/artifact tests passed in 2.31s; the added terminal-group test passed in the 185ms command lane.
  - [x] Verify and commit subprocess ownership: typecheck/build passed; command and built-CLI regressions passed 28 tests in 5.27s. Includes a SIGTERM-ignoring lifecycle, 2 MiB logs, private mutation and cwd-sensitive npm probe. Windows cancellation still needs its platform lane; diagnostics remain open below.
- [x] Release correctness — preflight now checks tag reference, matching manifest and nonempty unique notes in the unprivileged verify job and before publication. Reruns compare candidate bytes with registry dist.integrity before attestation/assets; registry failures are distinct from 404. Workflow keeps `needs: verify` and its filename. Verified: typecheck, 13 release tests in 123ms (including loopback HTTP errors and a SHA-512 standard vector), and actual `GITHUB_REF=refs/tags/v0.7.3 bun scripts/release.ts preflight`. No live release/OIDC claim or remote mutation. Workflow action-update check is required before commit.
- [ ] Dependency and routine-check health — ACTIVE. Basis: fix audited development dependency advisories without inflating runtime dependencies.
  - [x] Updated compatible Vite/PostCSS/nanoid dependencies; only bun.lock changed. `bun audit` found no vulnerabilities among 246 packages; the updated runner passed 82 archive/manifest tests in 104ms. The existing build also passed during install.
  - [x] Full local lane passes in 3.514s: formatting, repository invariants, typecheck, build, 196 tests across nine files (2.25s), and cleaned-artifact validation with publint/attw. Independent read-only checks run in parallel. A first 2.853s pass exposed an unsafe proposed overlap: self-packing runs prepare and rewrites dist, so it must follow CLI tests. Removed that race and documented the dependency; the faster pass does not count as valid closure.
  - [x] Advisory scanning runs in the existing unprivileged CI check job, outside the ordinary local lane. It adds current vulnerability evidence without requiring the network for every local check. The compatible-lockfile audit found no advisories.
  - [x] Dependency/check changes verified; workflow action-update check found no updates. Windows execution and live trusted publication are not claimed by local evidence.
- [ ] Documentation and final integration — basis: published promises must match observable behavior.
  - [x] Corrected pnpm/npm provenance exclusivity claims using pnpm's current publish documentation and npm's installed upload/pack implementation; uploader unchanged. Historical packer measurements are explicitly version-bounded. Bun 1.4.1 directly imported node:sqlite.DatabaseSync, falsifying the old warning; Art confirmed the recent Bun upgrade.
  - [x] Corrected lifecycle source-mutation, consumed publishConfig overrides, external-publisher preview boundary, bundled-dependency and runtime-version claims. Removed repeated packer arguments and unsupported comparative absolutes.
  - [x] Kept artifact-preservation and runtime reasons beside their owners; moved misplaced registry documentation onto withRegistry and corrected the suspicious-files opt-out comment.
  - [x] R3 proposal withdrawn: no demonstrated need for a new JSON-report interface. Art's minimal-sufficiency instruction supports keeping the existing CLI surface; no approved capability is removed.
  - [ ] Audit every final changed line against the baseline and pair every promise with an appropriate observable check.
  - [ ] Run the full routine lane, record its scope and duration, inspect final git diff/status and commit remaining verified work.

## Evidence and process corrections

Initial audit: `bun run check` passed with six test files and 121 tests; this does not cover the reproduced long-path scan bypass, workspace substitution, scoped registry override, packed private flag, deleted lifecycle helper, verbose-output failure or cancellation leak. These are regression targets, not completion evidence.

The first resumed read exceeded the outer tool output budget despite bounded inner calls. The tool explicitly reported truncation; omitted content is not treated as read. Keep each response within its total output budget and reread required omitted ranges. This affects evidence acquisition, not repository behavior; no global guidance change is authorized. The existing guard is insufficient at the outer aggregation boundary: a candidate harness fix is per-result output budgeting with retained full results (Aponte tool-output owner), not more project prose. No change in another repository is authorized. No claim about the psychological cause is needed for this repair.

## Beyond this scope

No additional work is approved here. Evaluate a pnpm-only uploader only as an alternative in the existing rationale; source support for provenance does not prove equivalent publication, lifecycle, registry or live OIDC behavior. Adoption needs Art's ruling.
