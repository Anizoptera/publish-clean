/**
 * The rules take a list of strings and read nothing else, so a hostile matrix costs microseconds
 * and every evasion worth trying is affordable here. That is the whole reason these live apart
 * from the end-to-end suite, which proves the CLI reaches them on a real packer's output and
 * cannot afford breadth.
 *
 * Both rules ABORT a publish, so the cases that matter most are the CONTROLS: a fold or a
 * predicate that over-matches refuses correct packages wholesale, and no author can override it.
 */
import { describe, expect, it } from "vitest";

import { isFatal } from "../src/finding";
import type { JsonObject } from "../src/json";
import { reviewPackedNames } from "../src/packed-names";

describe.concurrent("names that do not survive extraction", () => {
  const rules = (files: readonly string[], pkg: JsonObject = {}) =>
    reviewPackedNames(pkg, files).map((finding) => finding.rule);
  const message = (files: readonly string[], pkg: JsonObject = {}) =>
    reviewPackedNames(pkg, files)
      .map((finding) => finding.message)
      .join("\n");

  it("reports two names a folding filesystem merges into one file", () => {
    expect(rules(["README.md", "readme.md"])).toContain("packed-name-collision");
    expect(rules(["lib/Util.js", "lib/util.js"])).toContain("packed-name-collision");
    // The whole phrase, not the bare axis: the message's opening sentence names BOTH axes, so
    // asserting "letter case" alone passes on every collision and tests nothing.
    expect(message(["README.md", "readme.md"])).toContain("differ only in letter case");

    // Escapes, because the two forms render identically: an editor — and this repository's own
    // tooling — normalises a pasted literal, which would silently collapse the case to one name
    // and leave it asserting nothing.
    const composed = "caf\u00e9.js";
    const decomposed = "caf\u0065\u0301.js";
    expect(composed).not.toBe(decomposed);
    expect(rules([composed, decomposed])).toContain("packed-name-collision");
    // NFC collapses form, so an equal NFC form leaves form as the only difference. Getting this
    // backwards would tell an author to fix the one thing that is already identical.
    expect(message([composed, decomposed])).toContain("differ only in Unicode form");
  });

  it("stays silent on names that collide nowhere", () => {
    // The control that matters: every package on earth passes through this rule, so a fold that
    // over-matches refuses correct publishes wholesale rather than in some corner case.
    expect(
      rules(["index.js", "index.d.ts", "lib/a.js", "lib/b.js", "LICENSE", "license.md"]),
    ).toEqual([]);
    // Case differing in a DIRECTORY component loses no file: on a folding filesystem both land in
    // one directory, on a splitting one both directories exist, and both files survive either way.
    expect(rules(["lib/a.js", "Lib/b.js"])).toEqual([]);
  });

  it("reports a file and a directory that fold onto the same path", () => {
    // Neither name is a duplicate of the other, so the fold-by-path check alone reports nothing —
    // yet the installer writes the file and then cannot mkdir over it, failing the install. Only
    // a case-sensitive filesystem can author the pair, so its author never sees it.
    expect(rules(["lib", "Lib/x.js"])).toContain("packed-name-collision");
    expect(message(["lib", "Lib/x.js"])).toContain("Lib/");
    // The same shape with no case difference at all: a crafted archive can carry both, and the
    // tarball reader's duplicate-NAME check does not see it either.
    expect(rules(["lib", "lib/x.js"])).toContain("packed-name-collision");
    // Deeper than the first component, and the control beside it: a directory that is only ever a
    // directory must stay silent however many files sit under it.
    expect(rules(["a/b", "a/B/c.js"])).toContain("packed-name-collision");
    expect(rules(["a/b/c.js", "a/b/d.js", "a/b.txt"])).toEqual([]);
  });

  it("reports a name a consumer's filesystem cannot create", () => {
    expect(rules(["aux.js"])).toContain("packed-name-unportable");
    // In ANY component, not just the basename — Windows reserves the device names throughout a
    // path, and a check reading only the last segment reports a clean package.
    expect(rules(["lib/aux/index.js"])).toContain("packed-name-unportable");
    expect(rules(["a:b.js"])).toContain("packed-name-unportable");
    expect(rules(["weird\nname.js"])).toContain("packed-name-unportable");
    expect(rules(["trailing..js"])).toEqual([]);
    expect(rules(["trailing.js."])).toContain("packed-name-unportable");
    expect(rules(["trailing.js "])).toContain("packed-name-unportable");

    // Near misses, in the same position. A prefix test would refuse every one of these, and they
    // are ordinary filenames that ship in real packages.
    expect(
      rules(["contest.js", "console.js", "nullable.js", "communicate.js", "auxiliary.js"]),
    ).toEqual([]);
  });

  it("holds the 255-byte component boundary", () => {
    expect(rules(["a".repeat(255)])).toEqual([]);
    expect(rules(["a".repeat(256)])).toContain("packed-name-unportable");
    // Bytes, not characters: the limit every filesystem here enforces is a byte count, so a name
    // well under 255 characters can still exceed it.
    expect(rules(["\u00e9".repeat(200)])).toContain("packed-name-unportable");
  });

  it("waives the Windows rules for a package that does not run on Windows", () => {
    // Refusing a publish over a platform the author already opted out of is the failure this
    // codebase rates worst, and `os` is npm's own gate rather than a flag invented here.
    expect(rules(["aux.js"], { os: ["!win32"] })).toEqual([]);
    expect(rules(["aux.js"], { os: ["darwin", "linux"] })).toEqual([]);
    expect(rules(["aux.js"], { os: ["win32", "darwin"] })).toContain("packed-name-unportable");
    expect(rules(["aux.js"], { os: ["!darwin"] })).toContain("packed-name-unportable");
    expect(rules(["aux.js"], { os: [] })).toContain("packed-name-unportable");
    expect(rules(["aux.js"], { os: "darwin" })).toContain("packed-name-unportable");

    // Per REASON, not per rule: an over-long component fails on ext4 and APFS too, so no platform
    // claim waives it. A gate applied to the whole rule would silently drop this.
    expect(rules(["a".repeat(256)], { os: ["darwin"] })).toContain("packed-name-unportable");

    // Per reason is not enough on its own: ONE name can hold several, so a scan that reports the
    // first defect it meets and waives on THAT defect's platform hands the waiver authority over a
    // reason it does not own. Reachable inside one component and across two.
    expect(rules([`aux.${"a".repeat(300)}`], { os: ["!win32"] })).toContain(
      "packed-name-unportable",
    );
    expect(rules([`aux/${"a".repeat(300)}.js`], { os: ["!win32"] })).toContain(
      "packed-name-unportable",
    );
    // The same ordering decides the ADVICE. Telling an author to declare `!win32` over a name that
    // ext4 refuses anyway sends them to do the one thing that cannot help.
    expect(message([`aux.${"a".repeat(300)}`])).not.toContain(`"os": ["!win32"]`);
    // A collision is not a platform claim either.
    expect(rules(["A.js", "a.js"], { os: ["darwin"] })).toContain("packed-name-collision");
  });

  it("stops the run rather than warning", () => {
    // Consequence, not severity, decides the exit here: a file lost on install cannot be undone
    // once the version is on the registry, so this must be fatal with no --strict.
    for (const files of [["A.js", "a.js"], ["aux.js"]])
      for (const finding of reviewPackedNames({}, files)) {
        expect(finding.consequence).toBe("breaks");
        expect(finding.healed).toBe(false);
        expect(isFatal(finding, false)).toBe(true);
      }
  });
});
