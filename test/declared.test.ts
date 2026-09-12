/**
 * Falsifies what the manifest declares against what the archive carries. These rules fail by
 * refusing a package that works — a target that resolves on the build machine and nowhere else
 * looks identical to one that is simply absent — so every positive below is paired with the
 * control one character away from it.
 */
import { describe, expect, it } from "vitest";

import { reviewDeclaredFiles, normalizeDeclaredPath } from "../src/declared";

it("keeps side-effect globs as selectors rather than mandatory files", () => {
  expect(
    reviewDeclaredFiles({ main: "index.js", sideEffects: ["./**/*.css", "./{a,b}.js"] }, [
      "index.js",
    ]),
  ).toEqual([]);
  // A literal path is REPORTED, not fatal. `sideEffects` is read by a bundler's own resolver, so an
  // entry it cannot match marks nothing — it can never hand a stranger the wrong file. @sinclair/typebox
  // ships two such paths and installs correctly. `main` resolves here, which is what separates a
  // stale hint from the unpacked build the throw exists for.
  expect(
    reviewDeclaredFiles({ main: "index.js", sideEffects: ["./missing.js"] }, ["index.js"])[0]?.rule,
  ).toBe("declared-path-inert");
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
      reviewDeclaredFiles(
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
      reviewDeclaredFiles({ main: "missing.js", bin: { x: "bin/missing.js" } }, shipped),
    ).toThrow(/missing\.js[\s\S]*bin\/missing\.js/);
  });

  // Both targets below resolve wherever the filesystem ignores case or Unicode form, which is
  // where they were built, so the author is looking straight at the file the report calls missing.
  // Naming the entry it nearly matches is the difference between a one-line fix and a hunt through
  // a build that works.
  it("tells a wrong-case or wrong-Unicode target from an absent file", () => {
    expect(() => reviewDeclaredFiles({ main: "./dist/Index.js" }, shipped)).toThrow(
      /"dist\/index\.js", which differs only in case/,
    );
    // Escapes, because the two forms are indistinguishable in an editor — which is exactly
    // why this ships: a decomposed target against the composed name macOS reports from readdir.
    expect(() => reviewDeclaredFiles({ main: "./caf\u0065\u0301.js" }, ["caf\u00e9.js"])).toThrow(
      /Unicode form/,
    );

    // The control, in the same position: a file that genuinely is not there must not be handed a
    // near match, which would send the author renaming a file that was never built.
    expect(() => reviewDeclaredFiles({ main: "./dist/other.js" }, shipped)).toThrow(
      /"\.\/dist\/other\.js"\s*$/,
    );
  });

  /**
   * Each shape here was REFUSED by the exact-name ladder this replaced, and each belongs to a
   * package that installs and resolves — 373 of 5192 installed manifests on one machine, including
   * every `@types/*` package, every `@aws-sdk` client, `@babel/runtime`, `vite` and `svelte`. A
   * refusal is the outcome with no undo, so every case below is paired with the control that must
   * still stop the run.
   */
  it("reads an empty main as the unset field npm and Node read it as", () => {
    // `"main": ""` beside a types-only archive with no `index.js` is how DefinitelyTyped ships.
    expect(reviewDeclaredFiles({ main: "", types: "index.d.ts" }, ["index.d.ts"])).toEqual([]);
    // The control, one character away: a directory form IS a declaration and still wants an index.
    expect(() => reviewDeclaredFiles({ main: ".", types: "index.d.ts" }, ["index.d.ts"])).toThrow(
      /missing/,
    );
  });

  it("resolves a browser or module entry the way the bundler reading it does", () => {
    // `"./dist-es/runtimeConfig": "./dist-es/runtimeConfig.browser"` in every @aws-sdk client, and
    // `"module": "es"` in common-tags, which names a directory and leans on index resolution.
    expect(
      reviewDeclaredFiles({ browser: { "./a": "./b.browser" }, module: "es" }, [
        "b.browser.js",
        "es/index.js",
      ]),
    ).toEqual([]);
    // `bin` gets none of that tolerance: npm symlinks the exact path it is handed, so nothing fills
    // the gap and an inexact name is a command that cannot run. `cli.js` ships here, which is
    // exactly what a main-like resolver would have accepted — without it this case passes for the
    // wrong reason and says nothing about which resolver `bin` got.
    expect(() =>
      reviewDeclaredFiles({ bin: "./cli", main: "./index.js" }, ["index.js", "cli.js"]),
    ).toThrow(/\.\/cli/);
  });

  it("reports a stale hint or a dead pattern rather than refusing the package", () => {
    // @opentelemetry maps `src/` paths that only ever ship as `dist/`; @anthropic-ai/sdk generates
    // one exports entry per repository file, `.github/*` included; @smithy kept a `typesVersions`
    // tree for TypeScript 3.4 after dropping the files. All three install and resolve.
    const stale = reviewDeclaredFiles(
      {
        browser: { "./a": "./src/x.ts" },
        exports: { ".": "./index.js", "./g/*": "./g/*.js" },
        imports: { "#t": "./src/x.ts" },
      },
      ["index.js"],
    );
    expect(stale.map((finding) => finding.rule)).toEqual([
      "declared-path-inert",
      "declared-path-inert",
      "declared-path-inert",
    ]);
    // Warning, not error: `--strict` is the ruled way to demand otherwise, and a repair is
    // impossible here because only the author knows whether to delete the entry or pack the file.
    expect(stale.every((finding) => finding.consequence === "waste" && !finding.healed)).toBe(true);
  });

  it("still refuses an archive carrying nothing the manifest declares", () => {
    // The unpacked-build case, and the reason a dead pattern is safe to report above: here EVERY
    // route into the package is dead, so it cannot be used at all rather than carrying a stale hint.
    expect(() => reviewDeclaredFiles({ exports: { "./*": "./dist/*.js" } }, ["README.md"])).toThrow(
      /missing/,
    );
    // One resolvable route is the entire difference between the two verdicts.
    expect(
      reviewDeclaredFiles({ exports: { ".": "./index.js", "./*": "./dist/*.js" } }, ["index.js"]),
    ).toHaveLength(1);
  });

  it("takes a directory target as the prefix it is, not a file name", () => {
    // `"./regenerator/": "./regenerator/"` — @babel/runtime keeps the folder mapping Node dropped
    // in 17 for its Node 12-16 consumers, beside the `*` pattern modern Node takes instead.
    expect(reviewDeclaredFiles({ exports: { "./r/": "./r/" } }, ["r/index.js"])).toEqual([]);
    // @oxc-project/runtime carries that same key and moved the directory to `src/`: nothing sits
    // under the prefix, so the subpath resolves nowhere and the package really is broken.
    expect(() =>
      reviewDeclaredFiles({ exports: { ".": "./index.js", "./r/": "./r/" } }, [
        "index.js",
        "src/index.js",
      ]),
    ).toThrow(/r\//);
  });

  it("refuses a path that escapes the package", () => {
    expect(() => reviewDeclaredFiles({ main: "../outside.js" }, shipped)).toThrow(
      "invalid package paths",
    );
  });
});
