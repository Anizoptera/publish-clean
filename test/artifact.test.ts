/**
 * Every rule here judges a file list, so a case costs microseconds and the evasions that matter
 * are all affordable. The end-to-end suite proves the CLI reaches these and that a real packer
 * emits the paths they judge; what it cannot afford is breadth, so the matrices live here.
 */
import { describe, expect, it } from "vitest";

import { assertDeclaredFiles, normalizeDeclaredPath, validatePackedFiles } from "../src/artifact";
import { isFatal } from "../src/finding";
import { PublishCleanError } from "../src/error";

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

  // The refusal is the cheap half. A packed key is already outside the author's repository, so
  // the only repair that still works is rotation — and an author told merely to fix `files`
  // reads that as the whole fix and leaves a live credential in a tarball on a build machine.
  // The control is the same refusal over content that carries no credential: advising rotation
  // there is noise that teaches readers to skim the paragraph that matters.
  it("says to rotate a packed credential, and says it only for credentials", () => {
    expect(() => validatePackedFiles(["index.js", "deploy/id_ed25519"], false)).toThrow(/rotate/i);
    expect(() =>
      validatePackedFiles(["index.js", "node_modules/left-pad/index.js"], false),
    ).toThrow(/files/);
    expect(() =>
      validatePackedFiles(["index.js", "node_modules/left-pad/index.js"], false),
    ).not.toThrow(/rotate/i);
  });

  it("passes a package that carries none of them", () => {
    expect(() =>
      validatePackedFiles(["index.js", "index.d.ts", "README.md", "src/env.js"], false),
    ).not.toThrow();
  });
});

// The default hygiene check, and the one an author meets most often: a package shipping its own
// test tree or lockfile cannot publish until someone decides. It reports rather than throwing, so
// the run goes on to collect every other defect, and still refuses — the assertions below pin both
// halves, because a finding that stopped being fatal would look like a passing test.
// `--allow-suspicious` exists precisely because that verdict is a judgement call, unlike a leaked
// key, which is never one and therefore still throws.
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
      const [finding] = validatePackedFiles(["index.js", file], false);
      expect(finding?.rule).toBe("suspicious-file");
      expect(finding?.message).toContain(file);
      // Reporting rather than throwing must not turn the refusal into a warning: this is the
      // half of the change that a reader cannot see from the return type alone.
      expect(finding && isFatal(finding, false)).toBe(true);
    });
  }

  it("lets the author overrule the whole judgement at once", () => {
    expect(validatePackedFiles(["index.js", ...junk], true)).toEqual([]);
  });

  // The patterns are anchored at a path segment, so a file that merely CONTAINS one of these
  // words is ordinary source and must publish untouched — over-refusing here would make the
  // default unusable and push every author to the escape hatch.
  it("does not refuse ordinary source that merely reads like it", () => {
    expect(
      validatePackedFiles(
        ["latest/index.js", "src/contest.js", "protests.js", "my-tsconfig.json.js", "testing.js"],
        false,
      ),
    ).toEqual([]);
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
