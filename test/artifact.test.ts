/**
 * Every rule here judges a file list, so a case costs microseconds and the evasions that matter
 * are all affordable. The end-to-end suite proves the CLI reaches these and that a real packer
 * emits the paths they judge; what it cannot afford is breadth, so the matrices live here.
 */
import { describe, expect, it } from "vitest";

import {
  assertDeclaredFiles,
  normalizeDeclaredPath,
  reviewPackedNames,
  validatePackedFiles,
} from "../src/artifact";
import { PublishCleanError } from "../src/error";
import { isFatal } from "../src/finding";
import type { JsonObject } from "../src/json";

it("keeps side-effect globs as selectors rather than mandatory files", () => {
  expect(() =>
    assertDeclaredFiles({ sideEffects: ["./**/*.css", "./{a,b}.js", "./[a-z].js"] }, ["index.js"]),
  ).not.toThrow();
  expect(() => assertDeclaredFiles({ sideEffects: ["./missing.js"] }, ["index.js"])).toThrow(
    /missing/,
  );
});

describe.concurrent("critical file patterns", () => {
  // The package's headline promise is that a private key cannot reach the registry, so the
  // ways a key file evades a pattern are the failures that matter most. An SSH key carries no
  // extension at all, and on the case-insensitive filesystems most packages are built on
  // `Server.PEM` is the same file as `server.pem`.
  const secrets = [
    "id_rsa",
    "id_dsa",
    "deploy/id_ed25519",
    "Server.PEM",
    "certs/private.Key",
    ".env",
    "config/deploy.key",
    ".git/config",
    "node_modules/left-pad/index.js",
  ];

  for (const secret of secrets) {
    it(`refuses to publish ${secret}`, () => {
      expect(() => validatePackedFiles(["index.js", secret], false)).toThrow(PublishCleanError);
    });
  }

  // A guard that stopped at the first offender passed every single-file case above, and an
  // author who deletes the one name it printed would publish the rest.
  it("names every offender at once, not just the first", () => {
    let message = "";
    try {
      validatePackedFiles(["index.js", ...secrets], false);
    } catch (error) {
      message = (error as Error).message;
    }
    for (const secret of secrets) expect(message).toContain(secret);
  });

  it("keeps refusing critical files when suspicious checks are skipped", () => {
    expect(() => validatePackedFiles(["index.js", ".env"], true)).toThrow(
      "Critical files must not be published",
    );
  });

  it("passes a package that carries none of them", () => {
    expect(() =>
      validatePackedFiles(["index.js", "index.d.ts", "README.md", "src/env.js"], false),
    ).not.toThrow();
  });
});

// The default hygiene check, and the one an author meets most often: it refuses outright
// rather than warning, so a package shipping its own test tree or lockfile cannot publish
// until someone decides. `--allow-suspicious` exists precisely because that verdict is a
// judgement call, unlike a leaked key, which is never one.
describe.concurrent("suspicious file patterns", () => {
  const junk = [
    "test/index.test.js",
    "tests/helper.js",
    "__tests__/x.js",
    "__snapshots__/x.snap",
    "coverage/lcov.info",
    ".github/workflows/ci.yml",
    "tsconfig.json",
    "tsconfig.build.json",
    "pnpm-lock.yaml",
    "bun.lock",
    "package-lock.json",
    "src/index.test.ts",
    "src/index.spec.tsx",
  ];

  for (const file of junk) {
    it(`refuses to publish ${file}`, () => {
      expect(() => validatePackedFiles(["index.js", file], false)).toThrow("Suspicious files");
    });
  }

  it("lets the author overrule the whole judgement at once", () => {
    expect(() => validatePackedFiles(["index.js", ...junk], true)).not.toThrow();
  });

  // The patterns are anchored at a path segment, so a file that merely CONTAINS one of these
  // words is ordinary source and must publish untouched — over-refusing here would make the
  // default unusable and push every author to the escape hatch.
  it("does not refuse ordinary source that merely reads like it", () => {
    expect(() =>
      validatePackedFiles(
        ["latest/index.js", "src/contest.js", "protests.js", "my-tsconfig.json.js", "testing.js"],
        false,
      ),
    ).not.toThrow();
  });
});

describe.concurrent("declared manifest paths", () => {
  it("accepts paths inside the package", () => {
    expect(normalizeDeclaredPath("./index.js")).toBe("index.js");
    expect(normalizeDeclaredPath("dist/index.js")).toBe("dist/index.js");
    expect(normalizeDeclaredPath("./dist/../index.js")).toBe("index.js");
  });

  for (const escape of ["../secret.tgz", "./../secret.tgz", "/etc/passwd", "..", ".", ""]) {
    it(`refuses ${escape || "an empty path"}, which does not name a packed file`, () => {
      expect(normalizeDeclaredPath(escape)).toBeNull();
    });
  }
});

describe.concurrent("declared entry points", () => {
  const shipped = ["index.js", "index.d.ts", "dist/index.js", "dist/index.d.ts"];

  // The two families of path-bearing fields disagree about what a bare string means, and
  // reading one by the other's rules breaks in both directions. Only `imports` may name
  // an external package; export targets must name files inside this package.
  it("does not mistake package names, globs or booleans for paths", () => {
    expect(() =>
      assertDeclaredFiles(
        {
          exports: { ".": { types: "./index.d.ts", node: "./index.js", default: "./index.js" } },
          imports: { "#dep": "external-package" },
          sideEffects: false,
          typesVersions: { "*": { "*": ["dist/*.d.ts"] } },
        },
        shipped,
      ),
    ).not.toThrow();
  });

  it("names every declared file the tarball does not carry", () => {
    expect(() =>
      assertDeclaredFiles({ main: "missing.js", bin: { x: "bin/missing.js" } }, shipped),
    ).toThrow(/missing\.js[\s\S]*bin\/missing\.js/);
  });

  // Both targets below resolve wherever the filesystem ignores case or Unicode form, which is
  // where they were built, so the author is looking straight at the file the report calls missing.
  // Naming the entry it nearly matches is the difference between a one-line fix and a hunt through
  // a build that works.
  it("tells a wrong-case or wrong-Unicode target from an absent file", () => {
    expect(() => assertDeclaredFiles({ main: "./dist/Index.js" }, shipped)).toThrow(
      /"dist\/index\.js", which differs only in case/,
    );
    // Escapes, because the two forms are indistinguishable in an editor — which is exactly
    // why this ships: a decomposed target against the composed name macOS reports from readdir.
    expect(() => assertDeclaredFiles({ main: "./caf\u0065\u0301.js" }, ["caf\u00e9.js"])).toThrow(
      /Unicode form/,
    );

    // The control, in the same position: a file that genuinely is not there must not be handed a
    // near match, which would send the author renaming a file that was never built.
    expect(() => assertDeclaredFiles({ main: "./dist/other.js" }, shipped)).toThrow(
      /"\.\/dist\/other\.js"\s*$/,
    );
  });

  it("refuses a path that escapes the package", () => {
    expect(() => assertDeclaredFiles({ main: "../outside.js" }, shipped)).toThrow(
      "invalid package paths",
    );
  });
});

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
