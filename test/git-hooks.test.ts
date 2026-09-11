/**
 * The hook installer must never touch a repository that is not this one.
 *
 * `prepare` runs it on every install, and Git resolves `core.hooksPath` against the repository it
 * finds by walking UP from the working directory. So an unguarded write performed while this
 * package sits inside somebody else's checkout lands in THEIR config, pointing their hooks at a
 * `.githooks` that does not exist there and silently disabling every hook they have — a failure
 * with no error, in a repository whose owner never ran anything of ours.
 *
 * Both directions are asserted because either alone is satisfied by a script that does nothing.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const INSTALLER = path.resolve("scripts/git-hooks.ts");
const root = mkdtempSync(path.join(tmpdir(), "publish-clean-hooks-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Puts a copy of the real installer at `<where>/scripts/`, the layout it reads its root from. */
function installerAt(where: string): string {
  mkdirSync(path.join(where, "scripts"), { recursive: true });
  cpSync(INSTALLER, path.join(where, "scripts", "git-hooks.ts"));
  return path.join(where, "scripts", "git-hooks.ts");
}

const hooksPathOf = (repo: string): string =>
  execFileSync("git", ["config", "--get", "core.hooksPath"], {
    cwd: repo,
    encoding: "utf8",
    // The key being unset is the expected answer in one case and exits non-zero, which is not a
    // failure to run — reading it as one would turn the passing case into an error.
  }).trim();

describe.concurrent("wiring the commit hook", () => {
  it("refuses to write into the repository that merely encloses the install", () => {
    const consumer = path.join(root, "consumer");
    const installed = path.join(consumer, "node_modules", "publish-clean");
    mkdirSync(installed, { recursive: true });
    execFileSync("git", ["init", "-q", consumer]);
    const script = installerAt(installed);

    execFileSync("bun", [script, "--install"], { cwd: installed, stdio: "ignore" });

    // An unset key exits 1 with empty output, so the throw IS the assertion that nothing was written.
    expect(() => hooksPathOf(consumer)).toThrow();
  });

  it("wires the checkout it actually belongs to", () => {
    const own = path.join(root, "own");
    mkdirSync(own, { recursive: true });
    execFileSync("git", ["init", "-q", own]);
    const script = installerAt(own);

    execFileSync("bun", [script, "--install"], { cwd: own, stdio: "ignore" });

    expect(hooksPathOf(own)).toBe(".githooks");
  });
});
