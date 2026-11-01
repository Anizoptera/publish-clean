/**
 * Windows routes every spawn through cmd.exe, which parses the command line a second time
 * after Node has built it. These cases hold that seam: what cmd would interpret must never
 * reach it, and no other platform may pay for the rule.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { failureReason, run, spawnArgs } from "../src/command";

/**
 * A spawn failure reaches the reader as the only thing they get, so what it classifies decides
 * whether they can act. Driven directly rather than through a spawn because `ENOEXEC` cannot be
 * produced on Linux at all: glibc retries such a file under `/bin/sh`, so only macOS surfaces it.
 */
describe("spawn failure diagnosis", () => {
  const failed = (code: string): Error => Object.assign(new Error(`spawn ${code}`), { code });

  it("tells a reader whose tool is present and unrunnable what to do about it", () => {
    // The state every other check calls healthy: on PATH, executable bit set, kernel refuses it.
    // Naming the placeholder and the repair is the whole value; `spawn ENOEXEC` names neither.
    const reason = failureReason(failed("ENOEXEC"), "exited with 1");
    expect(reason).toMatch(/cannot be executed/);
    expect(reason).toMatch(/build scripts/);
  });

  it("keeps a missing tool distinct from an unrunnable one", () => {
    // Same class of complaint, opposite repair: install it, versus finish installing it.
    expect(failureReason(failed("ENOENT"), "exited with 1")).toMatch(/not available in PATH/);
  });

  it("separates a tool it may not execute from one the kernel cannot", () => {
    // Reached by `bun install -g pnpm`, which writes pnpm.mjs at 0644: execvp finds the file and
    // refuses it, while `command -v` stays silent because it lists only executables. Both halves
    // of the repair are the point — the bit, or a reinstall; `spawn pnpm EACCES` offers neither.
    const reason = failureReason(failed("EACCES"), "exited with 1");
    expect(reason).toMatch(/no execute permission/);
    expect(reason).toMatch(/chmod \+x/);
  });

  it("never swallows a failure it does not recognise", () => {
    // A code with no repair to teach must arrive verbatim: inventing advice for an exhausted file
    // table would send the reader after a permission bit that is not the problem.
    expect(failureReason(failed("EMFILE"), "exited with 1")).toBe("spawn EMFILE");
    expect(failureReason(undefined, "exited with 1")).toBe("exited with 1");
  });
});

describe("spawn arguments", () => {
  it("refuses an argument cmd.exe would split, rather than publishing the pieces", () => {
    // libuv quotes only for space, tab or quote, so `&` arrives at cmd unquoted and ends the
    // command there — `npm publish` would receive a truncated path and `D\x.tgz` would run.
    expect(() => spawnArgs("npm", ["publish", "C:\\R&D\\x.tgz"], "win32")).toThrow(/R&D/);
  });

  it("refuses a metacharacter in the command name too, not only in the arguments", () => {
    expect(() => spawnArgs("pn|pm", ["pack"], "win32")).toThrow(/pn\|pm/);
  });

  it.each(["a\nb", "a\rb"])("refuses command separators hidden in a line break", (argument) => {
    expect(() => spawnArgs("npm", [argument], "win32")).toThrow(/line breaks/);
  });

  it("wraps a safe vector without altering a single argument", () => {
    expect(spawnArgs("pnpm", ["pack", "--pack-destination", "C:\\Temp\\a b"], "win32")).toEqual([
      "cmd.exe",
      ["/d", "/c", "pnpm", "pack", "--pack-destination", "C:\\Temp\\a b"],
    ]);
  });

  it("leaves every other platform untouched, metacharacters included", () => {
    // The refusal is a cmd.exe rule. Applied anywhere else it would reject paths that a POSIX
    // exec passes through verbatim, since no shell is involved there at all.
    expect(spawnArgs("npm", ["publish", "/tmp/R&D/x.tgz"], "linux")).toEqual([
      "npm",
      ["publish", "/tmp/R&D/x.tgz"],
    ]);
  });
});

it("settles a cancelled real child before returning on this platform", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publish-clean-process-"));
  const controller = new AbortController();
  const reason = new Error("test cancellation");
  // Readiness is polled, not watched: macOS delivers `fs.watch` renames late or coalesced under
  // load, and a missed event let the timeout below settle the call instead of the cancellation.
  const ready = (async () => {
    while (!controller.signal.aborted) {
      if (
        await access(path.join(root, "ready")).then(
          () => true,
          () => false,
        )
      ) {
        controller.abort(reason);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  let result: Promise<unknown> | undefined;
  try {
    await writeFile(
      path.join(root, "child.cjs"),
      `
const fs = require('node:fs');
fs.writeFileSync('starting', String(process.pid));
fs.renameSync('starting', 'ready');
setInterval(() => {}, 1000);
`,
    );
    result = run(process.execPath, [path.join(root, "child.cjs")], root, {
      signal: controller.signal,
      // A runaway guard only, far above a loaded machine's child startup, so the cancellation is
      // the one thing that can settle this call.
      timeout: 60_000,
    }).catch((error: unknown) => error);
    expect(await result).toBe(reason);
    const pid = Number(await readFile(path.join(root, "ready"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort(reason);
    await result;
    await ready;
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "keeps interactive publishing in the caller's terminal group",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "publish-clean-terminal-"));
    try {
      await writeFile(
        path.join(root, "group.cjs"),
        `
const group = require('node:child_process').execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)]);
require('node:fs').writeFileSync('group', group);
`,
      );
      await run(process.execPath, [path.join(root, "group.cjs")], root, {
        output: "publish",
        timeout: 3000,
      });
      const parentGroup = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
        encoding: "utf8",
      });
      expect((await readFile(path.join(root, "group"), "utf8")).trim()).toBe(parentGroup.trim());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
