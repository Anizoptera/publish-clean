/**
 * Every rule here judges a file list, so a case costs microseconds and the evasions that matter
 * are all affordable. The end-to-end suite proves the CLI reaches these and that a real packer
 * emits the paths they judge; what it cannot afford is breadth, so the matrices live here.
 */
import { describe, expect, it } from "vitest";

import { assertDeclaredFiles, normalizeDeclaredPath, validatePackedFiles } from "../src/artifact";
import { PublishCleanError } from "../src/error";

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
// until someone decides. `--skip-file-check` exists precisely because that verdict is a
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
  const shipped = ["index.js", "index.d.ts", "dist/index.js"];

  // The two families of path-bearing fields disagree about what a bare string means, and
  // reading one by the other's rules breaks in both directions. In `exports` and `imports` a
  // string may be another package's name or a condition target, and treating those as paths
  // would refuse to publish any package whose conditions point at a dependency.
  it("does not mistake package names, globs or booleans for paths", () => {
    expect(() =>
      assertDeclaredFiles(
        {
          exports: { ".": { types: "./index.d.ts", node: "./index.js", default: "some-polyfill" } },
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

  it("refuses a path that escapes the package", () => {
    expect(() => assertDeclaredFiles({ main: "../outside.js" }, shipped)).toThrow(
      "invalid package paths",
    );
  });
});
