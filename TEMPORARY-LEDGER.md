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

Independent repairs are committed and the current lane passes. Remaining implementation depends on R1/R2/R4; the plan is not complete.

- [x] Simplified implementation: removed the help-parser subprocess matrix, order-insensitive comparator, obsolete error adapter and second temporary archive directory. Configuration/options moved intact into focused modules; isolated CLI cases run concurrently. Typecheck/build and the latest CLI/archive/actual-upload lane passed 55 tests in 2.37s. The owned tarball is rewritten directly and validated from disk; its original archive remains in memory for preservation checks.

- [x] Archive interpretation and preservation — effective USTAR/PAX paths and byte-counted records; size overrides; malformed tails and alias/duplicate rejection; final-readback raw entry/order/metadata guard. Verified: typecheck and build; `bunx vitest run test/tarball.test.ts test/cli.test.ts` passed 50 tests in 2.11s, including real pnpm safe/secret long paths and independent tar readback. Synthetic framing test corrected from a valid nine-byte record to a malformed eight-byte one; this was a test expectation error, not a parser fix.
- [ ] Publication identity and destination — Basis: npm must upload the checked artifact to the requested registry.
  - [ ] Implement R1 after ruling; test supported values and hostile selectors through actual npm and a loopback registry.
  - [x] Explicit registry pins general and scoped settings; actual npm loopback PUT selected /chosen/ despite scoped /wrong/ and matched retained bytes. Packed private manifests are refused, including lifecycle mutation. Tool probes are cwd-bound, bounded and reused. The fixture's placeholder auth key must match the registry path. Forwarded-option conflicts remain under R1.
  - [ ] Parse effective provenance intent and distinguish artifact preview from publication preflight.
  - [ ] Verify the completed publication surface, update its consumer documentation and commit.
- [ ] Manifest and consumer behavior — basis: cleaning must preserve useful consumer behavior and reject broken package references.
  - [ ] Implement R2 after ruling; exercise a real lifecycle calling a retained helper.
  - [ ] Complete script removal under R2. Consumer-resolved ecosystem fields are now protected; their regression cases pass.
  - [x] Consumer guards use final readback and pnpm's resolved manifest. Real npm installation retained a shipped file:vendor dependency; reject absent/outside targets and Windows spellings, preserve ordinary remote URLs. Node-backed cases corrected main fallback, literal stars, export URL/array/condition semantics; sideEffects globs may select nothing. Null-array fallback, swallowed configuration errors and numeric-condition mismatches failed before repair; latest typecheck and 110 path/manifest/artifact tests passed in 108ms. Removed the Node-disproved nested-main reader. Configuration shapes and consumer ecosystem fields are guarded, serialization is reused, and PAX labels are distinguished from the manifest member.
  - [ ] Verify the completed manifest surface after R2 and commit.
- [x] Process lifetime and diagnostics — stream verbose pack output, bound metadata capture, cancel process trees and wait before cleanup, preserve repeated-signal cleanup and terminal access for npm, escape diagnostic paths and retain error causes. Typecheck/build and 68 command/CLI/registry/artifact tests passed in 2.31s. POSIX terminal-group membership was independently checked with ps. Windows cancellation and dry-run are wired into its five-minute CI job; Windows execution remains unobserved here.
- [x] Release correctness — preflight checks tag identity and nonempty unique notes before publication. Reruns compare bytes with registry dist.integrity before attestation/assets; registry failures are distinct from 404. Verification remains unprivileged. Typecheck, 13 release tests including loopback HTTP errors and a SHA-512 vector, actual tagged-ref preflight and workflow action-update checks passed. Live release/OIDC is unobserved; no remote mutation.
- [x] Dependency/check health: compatible Vite/PostCSS/nanoid lockfile updates; bun audit found no advisories among 246 packages. Advisory lookup runs in unprivileged CI, keeping the ordinary local lane offline. Read-only gates run concurrently; self-application follows tests because prepare rebuilds dist. A proposed parallel overlap raced that build and was removed; its 2.853s pass is not closure evidence. Workflow action-update check found no updates.
- [ ] Documentation and final integration — basis: published promises must match observable behavior.
  - [x] Corrected provenance exclusivity, Bun SQLite, lifecycle, publishConfig, preview, bundling and runtime claims using current primary documentation and installed implementations. Restored the explicit pnpm-only ruling weakened by compression; updated temporary-tarball wording and narrowed lifecycle guarantees. Kept reasons beside the owning code and removed repeated unsupported claims.
  - [x] R3 proposal withdrawn: no demonstrated need for a new JSON-report interface. Art's minimal-sufficiency instruction supports keeping the existing CLI surface; no approved capability is removed.
  - [x] Audited the current total diff against the baseline. Archive semantics are checked against real pnpm plus independent tar; publication bytes against actual npm loopback PUT; path semantics against Node; process settlement against real children; release integrity against a known SHA-512 vector and loopback HTTP failures. This pass found and repaired the export resolver mismatches and weakened packer instruction. R1/R2/R4 remain known failures, so this is not publication readiness or whole-plan completion. Re-audit their eventual changes.
  - [x] Current full local lane passed in 3.720s: formatting, repository invariants, typecheck, build, 203 tests across nine files (2.34s), and built-CLI self-application with publint/attw. Total-diff whitespace check and working-tree inspection passed. No Windows execution, live OIDC, universal latency bound or 10x speedup is claimed.

## Evidence and process corrections

Initial audit: `bun run check` passed with six test files and 121 tests; this does not cover the reproduced long-path scan bypass, workspace substitution, scoped registry override, packed private flag, deleted lifecycle helper, verbose-output failure or cancellation leak. These are regression targets, not completion evidence.

Tool reads repeatedly exceeded inner or aggregate output budgets (captured examples: combined chunks aaafa5/e1f63c and chunk 5f2ae7). Truncation was explicit; required source/diff sections were reacquired, never treated as read from the omitted bytes. Cause of repeated selection of insufficient budgets remains unresolved and does not affect the product repair. Existing Aponte guidance already owns bounded readback in docs/standards/agent-gotchas.md, “Bind search POPULATION and readback BUDGET separately before execution.” Candidate prevention is retained full output plus per-result aggregate budgeting at the tool boundary, rather than another project rule. No Aponte or global guidance edit is authorized; this is a product implication only.

## Beyond this scope

No additional work is approved here. Evaluate a pnpm-only uploader only as an alternative in the existing rationale; source support for provenance does not prove equivalent publication, lifecycle, registry or live OIDC behavior. Adoption needs Art's ruling.
