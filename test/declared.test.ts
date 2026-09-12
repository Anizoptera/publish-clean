/**
 * Falsifies what the manifest declares against what the archive carries. These rules fail by
 * refusing a package that works — a target that resolves on the build machine and nowhere else
 * looks identical to one that is simply absent — so every positive below is paired with the
 * control one character away from it.
 */
import { describe, expect, it } from "vitest";

import { assertDeclaredFiles, normalizeDeclaredPath } from "../src/declared";

it("keeps side-effect globs as selectors rather than mandatory files", () => {
  expect(() =>
    assertDeclaredFiles({ sideEffects: ["./**/*.css", "./{a,b}.js", "./[a-z].js"] }, ["index.js"]),
  ).not.toThrow();
  expect(() => assertDeclaredFiles({ sideEffects: ["./missing.js"] }, ["index.js"])).toThrow(
    /missing/,
  );
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
