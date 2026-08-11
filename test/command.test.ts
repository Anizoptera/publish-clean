/**
 * Windows routes every spawn through cmd.exe, which parses the command line a second time
 * after Node has built it. These cases hold that seam: what cmd would interpret must never
 * reach it, and no other platform may pay for the rule.
 */
import { describe, expect, it } from "vitest";

import { spawnArgs } from "../src/command";

describe("spawn arguments", () => {
  it("refuses an argument cmd.exe would split, rather than publishing the pieces", () => {
    // libuv quotes only for space, tab or quote, so `&` arrives at cmd unquoted and ends the
    // command there — `npm publish` would receive a truncated path and `D\x.tgz` would run.
    expect(() => spawnArgs("npm", ["publish", "C:\\R&D\\x.tgz"], "win32")).toThrow(/R&D/);
  });

  it("refuses a metacharacter in the command name too, not only in the arguments", () => {
    expect(() => spawnArgs("pn|pm", ["pack"], "win32")).toThrow(/pn\|pm/);
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
