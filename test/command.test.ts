/**
 * Windows routes every spawn through cmd.exe, which parses the command line a second time
 * after Node has built it. These cases hold that seam: what cmd would interpret must never
 * reach it, and no other platform may pay for the rule.
 */
import { describe, expect, it } from "vitest";
import { watch } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { failureReason, run, spawnArgs } from "../src/command";

/**
 * A spawn failure reaches the reader as the only thing they get, so what it classifies decides
 * whether they can act. Driven directly rather than through a spawn because `ENOEXEC` cannot be
 * produced on Linux at all: glibc retries such a file under `/bin/sh`, so only macOS surfaces it.
 */
describe("spawn failure diagnosis", () => {
  const failed = (code: string): Error => Object.assign(new Error("spawn ENOEXEC"), { code });

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

  it("never swallows a failure it does not recognise", () => {
    expect(failureReason(failed("EACCES"), "exited with 1")).toBe("spawn ENOEXEC");
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
  // Windows temp paths may use 8.3 aliases, which libuv cannot safely watch (libuv#5010).
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "publish-clean-process-")));
  const controller = new AbortController();
  const reason = new Error("test cancellation");
  const watcher = watch(root, (_event, name) => {
    if (name === "ready") controller.abort(reason);
  });
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
      timeout: 3000,
    }).catch((error: unknown) => error);
    expect(await result).toBe(reason);
    const pid = Number(await readFile(path.join(root, "ready"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort(reason);
    await result;
    watcher.close();
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
