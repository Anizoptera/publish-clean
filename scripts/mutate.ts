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
 * minutes, and it answers a question asked when a guard is WRITTEN rather than on every commit. Its
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

  // --- src/finding.ts: what stops the run ------------------------------------------------------
  {
    name: "verdict forgets that a repair is not a defect",
    file: "src/finding.ts",
    from: /if \(finding\.healed\) return false;/,
    to: "",
  },
  {
    name: "verdict ignores the rule that carries its own abort",
    file: "src/finding.ts",
    from: /return finding\.rulesAbort === true \|\| strict;/,
    to: "return strict;",
  },
  {
    name: "verdict lets --strict promote a repair",
    file: "src/finding.ts",
    from: /if \(finding\.healed\) return false;/,
    to: "if (finding.healed) return strict;",
  },
  {
    name: "report labels an aborting finding a warning",
    file: "src/finding.ts",
    from: /isFatal\(finding, strict\) \? "error" : "warning"/,
    to: '"warning"',
  },
  {
    name: "decide stops at the first finding",
    file: "src/finding.ts",
    from: /return findings\.some\(\(finding\) => isFatal\(finding, strict\)\);/,
    to: "return findings.length > 0 && isFatal(findings[0], strict);",
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
