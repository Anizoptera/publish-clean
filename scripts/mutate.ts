#!/usr/bin/env bun
/**
 * Asks whether the suite would NOTICE each guard being removed: break one rule in the source,
 * require `bun run test` to go red, put the source back.
 *
 *     bun scripts/mutate.ts              every mutation, one suite run each
 *     bun scripts/mutate.ts frontier     only the rows whose name contains "frontier"
 *     bun scripts/mutate.ts --dry-run    plant nothing; report which patterns still match
 *
 * Nothing runs this automatically and nothing should: it is one full suite run per row, which is
 * minutes, and it answers a question asked when a guard is WRITTEN rather than on every commit.
 *
 * Do nothing else in this tree while it runs. Each row leaves the source damaged for the length of
 * one suite run, so a commit landing in that window fails its hook on a file nobody edited —
 * `Unreachable code detected` in whichever file is planted at that moment, which reads as a real
 * defect and sends the reader debugging a mutation that is about to be restored anyway. Its
 * value is that a green suite proves nothing on its own — a test that restates the implementation
 * passes whatever the implementation does, and this is the instrument that tells the two apart. The
 * rows are therefore a record of which properties are claimed to be guarded; a row that stops
 * matching is a claim that lost its subject, which is why an unmatched pattern is reported loudly
 * instead of counting as a pass.
 *
 * Three properties are load-bearing, and each one exists because its absence produced a false
 * reading here:
 *
 * RESTORE FROM THIS SCRIPT'S OWN COPY, never from Git. The code being proven is uncommitted exactly
 * while it is being proven, so `git restore` would DELETE it, and every later row would then plant
 * into a file that no longer holds the subject and report the suite's ordinary green — which reads
 * identically to a surviving mutant.
 *
 * A PLANT THAT MATCHED NOTHING IS NOT A RESULT. Same green, same reading, so the replacement is
 * compared against the original and a no-op is reported as `NOT PLANTED`.
 *
 * THE SUITE RUN IS BOUNDED BY THE PARENT PROCESS. A mutation that removes a resource bound is
 * precisely the mutation that hangs, so the harness proving such a bound is the one most likely to
 * be interrupted while the tree is damaged. A test-runner timeout cannot help — vitest's is
 * cooperative and cannot preempt synchronous allocation — and an external `timeout` binary is not
 * on every machine, where its absence would fail every run and report every mutant as killed. The
 * bound therefore lives in `spawnSync`, and the interrupt handlers below close the window that
 * `finally` cannot.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Generous against a cold cache; the suite is ~5s, so anything near this is a hang, not a slow run. */
const SUITE_TIMEOUT_MS = 120_000;

interface Mutation {
  readonly name: string;
  readonly file: string;
  readonly from: RegExp;
  readonly to: string;
}

const MUTATIONS: readonly Mutation[] = [
  // --- src/packed-names.ts: names the archive must not carry -----------------------------------
  {
    name: "foldName ignores letter case",
    file: "src/packed-names.ts",
    from: /return value\.normalize\("NFC"\)\.toLowerCase\(\);/,
    to: 'return value.normalize("NFC");',
  },
  {
    name: "foldName ignores Unicode form",
    file: "src/packed-names.ts",
    from: /return value\.normalize\("NFC"\)\.toLowerCase\(\);/,
    to: "return value.toLowerCase();",
  },
  {
    name: "unportable reads the basename only",
    file: "src/packed-names.ts",
    from: /for \(const part of name\.split\("\/"\)\) \{\n {4}const quoted/,
    to: 'for (const part of name.split("/").slice(-1)) {\n    const quoted',
  },
  {
    name: "reserved-name test drops its terminator",
    file: "src/packed-names.ts",
    from: /const RESERVED_DEVICE = .*/,
    to: "const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])/i;",
  },
  {
    name: "os gate never waives",
    file: "src/packed-names.ts",
    from: /function targetsWindows\(os: unknown\): boolean \{/,
    to: "function targetsWindows(os: unknown): boolean {\n  return true;",
  },
  {
    name: "os gate always waives",
    file: "src/packed-names.ts",
    from: /function targetsWindows\(os: unknown\): boolean \{/,
    to: "function targetsWindows(os: unknown): boolean {\n  return false;",
  },
  {
    name: "collision axis label inverted",
    file: "src/packed-names.ts",
    from: /\? "Unicode form"\n {16}: "letter case";/,
    to: '? "letter case"\n                : "Unicode form";',
  },
  {
    name: "component length limit removed",
    file: "src/packed-names.ts",
    from: /const MAX_COMPONENT_BYTES = 255;/,
    to: "const MAX_COMPONENT_BYTES = 1_000_000;",
  },
  {
    name: "collisions downgraded to a warning",
    file: "src/packed-names.ts",
    from: /rule: "packed-name-collision",\n {6}consequence: "breaks",/,
    to: 'rule: "packed-name-collision",\n      consequence: "waste",',
  },
  {
    name: "unportable names downgraded to a warning",
    file: "src/packed-names.ts",
    from: /rule: "packed-name-unportable",\n {6}consequence: "breaks",/,
    to: 'rule: "packed-name-unportable",\n      consequence: "waste",',
  },
  {
    name: "collision ignores file-vs-directory clashes",
    file: "src/packed-names.ts",
    from: /const clashing = directory === undefined \? group : \[\.\.\.group, `\$\{directory\}\/`\];/,
    to: "const clashing = group;",
  },
  {
    name: "directory walk stops at the first component",
    file: "src/packed-names.ts",
    from: /for \(let cut = file\.indexOf\("\/"\); cut !== -1; cut = file\.indexOf\("\/", cut \+ 1\)\)/,
    to: 'for (let cut = file.indexOf("/"); cut === -2; cut = file.indexOf("/", cut + 1))',
  },
  {
    name: "waiver moves back out to the caller",
    file: "src/packed-names.ts",
    from: /if \(!windows\) continue;\n/,
    to: "",
  },
  {
    name: "length limit no longer outranks a Windows reason",
    file: "src/packed-names.ts",
    from: /return \{ reason: `\$\{quoted\} is longer than 255 bytes`, windowsOnly: false \};/,
    to: "return { reason: `${quoted} is longer than 255 bytes`, windowsOnly: true };",
  },

  // --- src/tarball.ts: names carried by a header rather than by the entry they belong to --------
  // Only the GNU long-name rows are here. The rest of this file's guards predate the harness and
  // have none, which is a gap in the record rather than a claim that they are unguarded.
  {
    // The pre-fix blind spot: the member is judged under the placeholder in its own header while
    // it extracts somewhere else entirely.
    name: "GNU long name no longer names the entry that follows it",
    file: "src/tarball.ts",
    from: /local = new Map\(\[\["path", long\]\]\);/,
    to: "local = null;",
  },
  {
    name: "empty GNU long name falls back to the placeholder",
    file: "src/tarball.ts",
    from: /if \(end === 0\) throw new PublishCleanError\("Tarball has an empty GNU long-name entry\."\);/,
    to: "",
  },
  {
    name: "GNU long name may rename an entry onto the manifest",
    file: "src/tarball.ts",
    from: /if \(long === MANIFEST_PATH\)/,
    to: "if (false)",
  },

  // --- src/lexical.ts: where a specifier sits ---------------------------------------------------
  {
    // The pre-fix behaviour exactly: a template's inner backtick terminates the outer one.
    name: "lexer stops tracking template interpolation",
    file: "src/lexical.ts",
    from: /char === "\$" && next === "\{"/,
    to: 'char === "\\u0000"',
  },
  {
    name: "lexer ends an interpolation at the first brace",
    file: "src/lexical.ts",
    from: /if \(char === "\}" && depth === 0\) \{/,
    to: "if (char === `}`) {",
  },
  {
    name: "lexer accepts a file ending inside an interpolation",
    file: "src/lexical.ts",
    from: /if \(interpolations\.length > 0\) return null;/,
    to: "",
  },

  // --- src/artifact.ts: the two halves of the packed-file verdict -------------------------------
  {
    // The headline promise, and the whole of what makes it unwaivable: `harm` is fatal in
    // `isFatal` before any flag is read, where `waste` without `rulesAbort` is fatal only under
    // `--strict`. Hits the first row in the table, which is the secrets one.
    name: "a leaked key becomes a warning",
    file: "src/artifact.ts",
    from: /consequence: "harm"/,
    to: 'consequence: "waste"',
  },
  {
    // Table order is precedence. Flip it and `node_modules/x/.env` files as a packed directory,
    // so its owner is told to fix `files` and never told to rotate the key.
    name: "a credential inside a packed directory loses to the directory",
    file: "src/artifact.ts",
    from: /const rule = active\.find\(/,
    to: "const rule = active.findLast(",
  },
  {
    // Reporting rather than throwing is only sound while the finding stays fatal; drop this one
    // field and a package ships its own test tree with a warning nobody reads.
    name: "a shipped development file becomes a warning",
    file: "src/artifact.ts",
    from: /rulesAbort: true,/,
    to: "",
  },

  // --- src/finding.ts: what stops the run ------------------------------------------------------
  {
    name: "verdict forgets that a repair is not a defect",
    file: "src/finding.ts",
    from: /!finding\.healed && severityOf/,
    to: "severityOf",
  },
  {
    name: "verdict ignores the rule that carries its own abort",
    file: "src/finding.ts",
    from: /finding\.rulesAbort === true \|\| strict \?/,
    to: "strict ?",
  },
  {
    name: "verdict lets --strict promote a repair",
    file: "src/finding.ts",
    from: /return !finding\.healed && severityOf\(finding, strict\) === "error";/,
    to: 'return (!finding.healed || strict) && severityOf(finding, strict) === "error";',
  },
  {
    // The two axes collapsed back into one: severity read from what the run DID rather than from
    // the defect. It is the exact regression the split was for, and the whole table's precedent
    // is that a plausible-looking merge is what someone reaches for while tidying.
    name: "severity softens for a finding this run repaired",
    file: "src/finding.ts",
    from: /if \(finding\.consequence !== "waste"\) return "error";/,
    to: 'if (finding.consequence !== "waste") return finding.healed ? "warning" : "error";',
  },
  {
    name: "report labels every finding a warning",
    file: "src/finding.ts",
    from: /\$\{severityOf\(finding, strict\)\}/,
    to: "warning",
  },
  {
    // Converted from a throw so the rest of the run still reports. The risk the conversion adds
    // is that the refusal itself goes missing — a finding nobody made fatal is a warning nobody
    // acts on, and the package publishes with a live credential in its manifest.
    name: "a registry credential becomes a warning",
    file: "src/registry.ts",
    // Anchored on the neighbouring `where`, not on the consequence alone: a bare
    // `consequence: "harm"` would retarget itself to whichever harm rule lands in this file
    // next, still get killed by that rule's own case, and report green for a row testing
    // nothing. The dry run cannot see that — the pattern still matches.
    from: /consequence: "harm" as const,\n( +)healed: false,\n +where: `publishConfig/,
    to: 'consequence: "waste" as const,\n$1healed: false,\n$1where: `publishConfig',
  },
  {
    name: "a workspace-only dependency spec becomes a warning",
    file: "src/manifest.ts",
    from: /rule: "monorepo-only-spec",\n( +)consequence: "breaks" as const,/,
    to: 'rule: "monorepo-only-spec",\n$1consequence: "waste" as const,',
  },
  {
    name: "a mistyped flag escapes as the parser wrote it",
    file: "src/options.ts",
    from: /throw new PublishCleanError\(\n( +)`\$\{cause instanceof Error/,
    to: "throw cause;\n$1throw new PublishCleanError(\n$1  `${cause instanceof Error",
  },
  {
    name: "the verdict stops at the first finding",
    file: "src/finding.ts",
    from: /const fatal = findings\.filter\(/,
    to: "const fatal = findings.slice(0, 1).filter(",
  },

  // --- src/shipped.ts: what the package ships and what reaches it -------------------------------
  {
    name: "shipped: case-mismatch stops asking where the specifier sits",
    file: "src/shipped.ts",
    from: /inCode\(source, from, at\)/,
    to: "true",
  },
  {
    name: "shipped: dead-weight finding drops its own abort",
    file: "src/shipped.ts",
    from: /rulesAbort: true,/,
    to: "",
  },
  {
    name: "shipped: nested package.json loses its exemption",
    file: "src/shipped.ts",
    from: /\/\(\?:\^\|\\\/\)package\\\.json\$\/,/,
    to: "/^__never__$/,",
  },
  {
    name: "shipped: shebang check reads the whole file, not its first line",
    file: "src/shipped.ts",
    from: /if \(!firstLine\.includes\(0x0d\)\) continue;/,
    to: "if (!body.includes(0x0d)) continue;",
  },
  {
    name: "shipped: require branch stops consulting Node's parser",
    file: "src/shipped.ts",
    from: /if \(!body \|\| isCommonJs\(body\.toString\("utf8"\)\)\) continue;/,
    to: "if (!body) continue;",
  },
  {
    name: "shipped: dead-weight scan ignores the exports gate",
    file: "src/shipped.ts",
    from: /if \(pkg\.exports === undefined\) return \[\];/,
    to: "",
  },
  {
    name: "shipped: types branch accepts any script",
    file: "src/shipped.ts",
    from: /if \(!DECLARATION\.test\(target\) && SCRIPT\.test\(target\)\)/,
    to: "if (false)",
  },
  {
    name: "shipped: expand forgets the .js -> .d.ts convention",
    file: "src/shipped.ts",
    from: /\[name, swapped, swapped\.replace\(\/ts\$\/, "tsx"\), declared\]/,
    to: '[name, swapped, swapped.replace(/ts$/, "tsx")]',
  },
  {
    name: "shipped: expand forgets the extensionless .d.ts form",
    file: "src/shipped.ts",
    from: /, "\.node", "\.d\.ts"\]/,
    to: ', ".node"]',
  },

  // --- src/conditions.ts, src/exports.ts: the walk stays bounded --------------------------------
  {
    // Exactly the pre-fix behaviour: each recursive walk gets its own full budget, so the total is
    // never charged and the guard measures one subtree.
    name: "budget: each subtree gets its own allowance again",
    file: "src/conditions.ts",
    from: /flatten\(value, taken, sub, budget\);/,
    to: "flatten(value, taken, sub, { left: ROW_BUDGET });",
  },
  {
    name: "budget: the frontier of conjunctions is not charged",
    file: "src/conditions.ts",
    from: /if \(next\.length > pending\.length\) spend\(budget, next\.length - pending\.length\);/,
    to: "",
  },
  {
    name: "budget: an unenumerable map is healed anyway",
    file: "src/exports.ts",
    from: /if \(!reportReachability\(node, where, findings\)\) return node;/,
    to: "reportReachability(node, where, findings);",
  },

  // --- src/exports.ts: a shadowed condition is refused only when a consumer can lose it ---------
  // Each tolerance below exists because its absence refused a published, working package, and the
  // two fatality rows exist because a reader cannot otherwise tell a tolerance from a hole.
  {
    name: "order: a forced key WINNING is a violation again",
    file: "src/exports.ts",
    from: /if \(!\(TIERS\[later\]\?\.forced \?\? false\)\) continue;/,
    to: "if (!(TIERS[later]?.forced ?? false) && !(TIERS[earlier]?.forced ?? false)) continue;",
  },
  {
    name: "order: a winner re-dispatching on the loser is ignored",
    file: "src/exports.ts",
    from: /if \(isObject\(subtree\) && Object\.hasOwn\(subtree, loser\)\) continue;/,
    to: "",
  },
  {
    name: "order: two keys carrying the same target are told apart",
    file: "src/exports.ts",
    from: /if \(JSON\.stringify\(subtree\) === JSON\.stringify\(node\[loser\]\)\) continue;/,
    to: "",
  },
  {
    name: "order: every misordering is fatal again",
    file: "src/exports.ts",
    from: /worst \?\?= "waste";/,
    to: 'return "breaks";',
  },
  {
    name: "order: a shadowed runtime build is waved through",
    file: "src/exports.ts",
    from: /else return "breaks";/,
    to: 'else worst ??= "waste";',
  },

  {
    name: "shipped: bin shebang check reads its condition backwards",
    file: "src/shipped.ts",
    from: /if \(body\.subarray\(0, 2\)\.toString\(\) === "#!" \|\| body\.subarray\(0, 512\)\.includes\(0\)\) continue;/,
    to: 'if (!body.subarray(0, 2).toString().startsWith("#")) continue;',
  },
  {
    // The suppression that keeps a compiled command from reading as a defect. Removing it does not
    // weaken the rule, it makes the rule REFUSE packages that work — so the row proves the controls
    // holding that direction are real, not the finding.
    name: "shipped: bin shebang check demands one of a compiled binary too",
    file: "src/shipped.ts",
    from: / \|\| body\.subarray\(0, 512\)\.includes\(0\)\) continue;/,
    to: ") continue;",
  },
  {
    name: "shipped: bin scan stops seeing the bare spelling of a command path",
    file: "src/shipped.ts",
    from: /collectDeclaredPaths\(pkg\.bin, commands, "every-string"\);/,
    to: 'collectDeclaredPaths(pkg.bin, commands, "relative-only");',
  },

  // --- src/declared.ts: the two directions a declared path can be read wrong --------------------
  //
  // This guard is the tool's hardest stop — it THROWS, ahead of every report — and it had no rows
  // at all while it refused 373 of 5192 real published packages. Both directions need a row: the
  // tolerances below each exist because their absence fabricated a refusal, and the fatality beside
  // them exists because its absence would wave a genuinely unusable package through. A reader
  // tidying one cannot tell which kind they are holding, which is what these rows answer.
  {
    name: "declared: an empty main is treated as a path rather than an unset field",
    file: "src/declared.ts",
    from: /if \(value === ""\) return;/,
    to: "",
  },
  {
    name: "declared: module loses the index and extension resolution a bundler gives it",
    file: "src/declared.ts",
    from: /collect\(pkg\.module, "main"\);/,
    to: 'collect(pkg.module, "file");',
  },
  {
    // The opposite direction in one row: `bin` must NOT gain that tolerance, because npm symlinks
    // the exact path and nothing fills a gap in it.
    name: "declared: bin gains a tolerance npm does not give it",
    file: "src/declared.ts",
    from: /collect\(pkg\.bin, "file"\);/,
    to: 'collect(pkg.bin, "main");',
  },
  {
    name: "declared: a directory target is read as a file name again",
    file: "src/declared.ts",
    from: /if \(!found && name\.endsWith\("\/"\)\) found = published\.some\(\(file\) => file\.startsWith\(name\)\);/,
    to: "",
  },
  {
    // The same branch in the permissive direction, which no accept-side case can see: a prefix that
    // matches nothing must still refuse, or a package whose directory moved reads as correct.
    name: "declared: a directory target is accepted without anything under it",
    file: "src/declared.ts",
    from: /found = published\.some\(\(file\) => file\.startsWith\(name\)\);/,
    to: "found = true;",
  },
  {
    name: "declared: a stale bundler hint aborts the publish again",
    file: "src/declared.ts",
    from: /else if \(item\.inert \|\| item\.pattern\) \{/,
    to: "else if (false) {",
  },
  {
    // The row that matters most. Reporting an unreachable declaration instead of aborting is only
    // sound while the archive carrying NOTHING the manifest declares is still caught, and that
    // case looks exactly like the harmless one from inside the loop.
    name: "declared: an archive carrying nothing the manifest declares is waved through",
    file: "src/declared.ts",
    from: /if \(resolved === 0\) missing\.push/,
    to: "if (false) missing.push",
  },

  // --- src/command.ts: what reaches cmd.exe -----------------------------------------------------
  // 0.7.0 shipped with this hole open, found by a hostile argument rather than by packing a benign
  // repository, so these rows exist to keep the cases that found it attached to the guard. Both
  // directions are planted: a refusal that stops refusing publishes the pieces of a split command,
  // and one that spreads to POSIX refuses paths an `exec` passes through untouched.
  {
    name: "cmd.exe refusal stops refusing anything",
    file: "src/command.ts",
    from: /\/\[&\|<>\^%\(\)\\r\\n\]\//,
    to: "/(?!)/",
  },
  {
    name: "cmd.exe refusal reads the arguments but not the command name",
    file: "src/command.ts",
    from: /const unsafe = \[command, \.\.\.args\]/,
    to: "const unsafe = [...args]",
  },
  {
    name: "cmd.exe refusal overlooks a command separator written as a line break",
    file: "src/command.ts",
    from: /\[&\|<>\^%\(\)\\r\\n\]/,
    to: "[&|<>^%()]",
  },
  {
    name: "cmd.exe refusal spreads to platforms that never run a shell",
    file: "src/command.ts",
    from: /if \(platform !== "win32"\) return \[command, \[\.\.\.args\]\];/,
    to: 'if (platform !== "win32" && false) return [command, [...args]];',
  },

  // --- src/trusted-publish.ts: the identity npm signs for ---------------------------------------
  // A provenance attestation names a repository, and npm mints it from the workflow's OIDC token
  // rather than from the manifest. Disagreement between the two is therefore invisible at the
  // publish and permanent afterwards, which is why the refusals matter and why the two messages
  // must stay distinguishable — a mutant that falls through to the wrong one is still a mutant.
  {
    name: "trusted publish accepts a repository the workflow does not claim",
    file: "src/trusted-publish.ts",
    from: /if \(slug !== env\.GITHUB_REPOSITORY\)/,
    to: "if (slug !== env.GITHUB_REPOSITORY && false)",
  },
  {
    name: "trusted publish signs for a package that names no repository",
    file: "src/trusted-publish.ts",
    from: /if \(!repoUrl\)/,
    to: "if (!repoUrl && false)",
  },
  {
    name: "identity check never runs",
    file: "src/trusted-publish.ts",
    from: /if \(env\.GITHUB_ACTIONS !== "true" \|\| typeof env\.GITHUB_REPOSITORY !== "string"\) return;/,
    to: "return;",
  },
  {
    name: "identity check polices an ordinary publish outside Actions",
    file: "src/trusted-publish.ts",
    from: /if \(env\.GITHUB_ACTIONS !== "true" \|\| typeof env\.GITHUB_REPOSITORY !== "string"\) return;/,
    to: 'if (env.GITHUB_ACTIONS !== "true" && false) return;',
  },

  // --- scripts/git-hooks.ts: the installer stays inside this repository -------------------------
  {
    // The pre-fix behaviour exactly: wire unless there is no repository anywhere above, which in a
    // package installed under someone else's checkout means wiring THEIRS.
    name: "hooks: installer wires whatever repository encloses it",
    file: "scripts/git-hooks.ts",
    from: /if \(enclosingRepository\(\) !== realpathSync\(ROOT\)\)/,
    to: "if (enclosingRepository() === null)",
  },
  {
    // Refusing to wire, while clearing what the stranger already had — the same silent harm the
    // guard exists to prevent, reached from the branch that looks like it declines to act. It is
    // here because an assertion that a refused repository has NO hooksPath cannot see it: cleared
    // and never-written read identically, which is why the case asserts the value is still THEIRS.
    name: "hooks: refusing to wire still clears the wiring that was there",
    file: "scripts/git-hooks.ts",
    from: /\)\)\n {4}console\.error\(/,
    to: '))\n    git("config", "--unset", "core.hooksPath"), console.error(',
  },
];

/**
 * The file currently holding a planted defect, so an interrupt cannot leave the tree damaged.
 *
 * `finally` does not run when the process is killed, and this script is interrupted more than most:
 * a run is minutes long and the rows that hang are the ones worth waiting for.
 */
let damaged: { readonly file: string; readonly original: string } | null = null;

function restore(): void {
  if (damaged === null) return;
  writeFileSync(damaged.file, damaged.original);
  damaged = null;
}

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    restore();
    process.exit(130);
  });

/**
 * Runs the suite under a bound the parent owns, so a mutant that hangs still yields a verdict.
 *
 * Three outcomes rather than a boolean, because a killed run is not a failed run: collapsing them
 * loses the one reading that says the mutation removed a resource bound, which is the finding, not
 * a detail of it. A spawn that never produced a run at all is an instrument failure and throws —
 * reporting it as a verdict would mark every row killed and read as a suite in perfect health.
 */
function runSuite(): "passed" | "failed" | "stopped" {
  const run = spawnSync("bun", ["run", "test"], {
    cwd: ROOT,
    timeout: SUITE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    stdio: "ignore",
  });
  if (run.signal !== null) return "stopped";
  if (run.status === null) throw run.error ?? new Error("The suite produced no exit status.");
  return run.status === 0 ? "passed" : "failed";
}

const VERDICT = {
  passed: "SURVIVED ***",
  failed: "killed      ",
  stopped: "killed (hung)",
} as const;

// A substring argument runs one row, so a single hypothesis costs one suite run rather than all.
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const only = args.find((argument) => !argument.startsWith("--"));
const selected = MUTATIONS.filter((mutation) => !only || mutation.name.includes(only));
if (selected.length === 0) {
  console.error(
    `No mutation name contains ${JSON.stringify(only)}. Run without an argument for all.`,
  );
  process.exit(2);
}

const results: string[] = [];
for (const mutation of selected) {
  const target = path.join(ROOT, mutation.file);
  const original = readFileSync(target, "utf8");
  const mutated = original.replace(mutation.from, mutation.to);
  if (mutated === original) {
    results.push(`NOT PLANTED  ${mutation.name} — pattern matched nothing in ${mutation.file}`);
    continue;
  }
  if (dryRun) {
    results.push(`plants       ${mutation.name}`);
    continue;
  }
  try {
    damaged = { file: target, original };
    writeFileSync(target, mutated);
    results.push(`${VERDICT[runSuite()]} ${mutation.name}`);
  } finally {
    restore();
  }
}

// The suite must be green again after every restore, or a later reading measured a damaged tree.
if (!dryRun) results.push(`restored tree: ${runSuite() === "passed" ? "green" : "RED ***"}`);
console.log(results.join("\n"));
