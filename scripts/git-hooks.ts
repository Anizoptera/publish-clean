#!/usr/bin/env bun
/**
 * Owns where Git looks for this repository's hooks, and asserts that it will actually run them.
 *
 * `--install` points `core.hooksPath` at the tracked directory; with no argument it checks the
 * three facts that decide whether Git calls the hook AT ALL, and names the repair for each.
 *
 * A gate cannot detect that it is the wrong gate, which is why this check exists as well as the
 * hook. Measured in a sibling repository of Art's: a commit added a new hook without unwiring the
 * old one, and every check run for the next four commits was launched BY the stale copy and
 * reported green — each of those runs was a child of the defect, so none of them could report it.
 * Only an assertion about what Git executes escapes that, and it has to run in the lane rather than
 * in the hook.
 *
 * The executable bit is checked twice because the two answers differ and both matter. On DISK it
 * decides whether Git runs the hook here, and a hook without it is skipped with a one-line hint and
 * the commit is created at exit 0 — the quietest failure available. In the INDEX it decides what
 * every fresh clone and CI checkout gets, so a `100644` mode leaves the author gated and everybody
 * else silently ungated, which no local test can see.
 */
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

/** The tracked hooks directory. Git resolves `core.hooksPath` against the top of the worktree. */
const HOOKS_PATH = ".githooks";
const PRE_COMMIT = `${HOOKS_PATH}/pre-commit`;
const INSTALL = "bun run hooks:install";

/** This checkout, taken from the script's own location so no answer here depends on the cwd. */
const ROOT = path.resolve(import.meta.dirname, "..");
const PRE_COMMIT_FILE = path.join(ROOT, PRE_COMMIT);

/** Pinned to this checkout so the answers describe this repository and not the caller's cwd. */
const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", cwd: ROOT }).trimEnd();

/** The repository Git would act on from here, which is NOT always this one — see `--install`. */
function enclosingRepository(): string | null {
  try {
    return realpathSync(git("rev-parse", "--show-toplevel"));
  } catch {
    return null;
  }
}

if (process.argv[2] === "--install") {
  // `prepare` runs this on EVERY install, including ones that are not this checkout — a source
  // tarball, or this package pulled in as a git dependency under someone else's repository. Git
  // resolves `core.hooksPath` against the repository it finds by walking UP from here, so an
  // unguarded write lands in whatever encloses the install and points a stranger's hooks at a
  // `.githooks` that does not exist there, silently disabling every hook they have. Measured:
  // installing into `consumer/node_modules/publish-clean` set `core.hooksPath` in `consumer`.
  //
  // Nothing is wired unless the repository Git finds IS this one, and a refusal exits 0 because
  // breaking an install over hooks nobody asked for would be the larger harm.
  if (enclosingRepository() !== realpathSync(ROOT))
    console.error(
      `Not a checkout of this repository, so no commit hooks were wired. Run \`${INSTALL}\` inside a clone of it.`,
    );
  else git("config", "core.hooksPath", HOOKS_PATH);
  process.exit(0);
}

const problems: string[] = [];

// `git config --get` exits non-zero when the key is unset, which is one of the states being tested.
let configured: string | null = null;
try {
  configured = git("config", "--get", "core.hooksPath");
} catch {
  configured = null;
}
if (configured !== HOOKS_PATH)
  problems.push(
    `core.hooksPath is ${configured === null ? "unset" : JSON.stringify(configured)}, so Git ignores ${HOOKS_PATH}/ and nothing checks a commit.\n` +
      `    Repair: ${INSTALL}`,
  );

try {
  // The same question Git asks, and it follows a symlink to the target the way Git does.
  accessSync(PRE_COMMIT_FILE, constants.X_OK);
} catch {
  // Missing and present-but-unrunnable both end here and take different repairs, so a single
  // message would send half its readers to chmod a file that is not there.
  const gone = !existsSync(PRE_COMMIT_FILE);
  problems.push(
    `${PRE_COMMIT} is ${gone ? "missing" : "not executable"} on disk, so Git runs no check and creates the commit at exit 0.\n` +
      `    Repair: ${gone ? `git checkout -- ${PRE_COMMIT}` : `chmod +x ${PRE_COMMIT}`}`,
  );
}

// The mode Git RECORDS, which is what a fresh clone or CI checkout receives.
const staged = git("ls-files", "-s", "--", PRE_COMMIT);
if (!staged.startsWith("100755 "))
  problems.push(
    `${PRE_COMMIT} is ${staged === "" ? "untracked" : `tracked as mode ${staged.split(" ")[0]}`}, so every fresh clone gets an unrunnable hook however correct this working copy looks.\n` +
      `    Repair: git update-index --chmod=+x ${PRE_COMMIT}`,
  );

if (problems.length > 0) {
  console.error(
    `Git hook wiring is broken — commits are not being checked:\n  - ${problems.join("\n  - ")}`,
  );
  process.exit(1);
}
