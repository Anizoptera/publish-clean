/**
 * The three reviewers of `src/shipped.ts`, which read the files a package actually ships.
 *
 * They are separated here because they point in OPPOSITE safe directions and one scan carries
 * both. Reachability may over-match: a spurious match only hides a report. `import-case-mismatch`
 * and the self-import scan INVERT that — a spurious match invents a refusal of a correct package,
 * and a published version cannot be taken back. So every case that reports is paired with the
 * control that must stay silent, in the same position, usually one character apart.
 *
 * Falsifies the self-import check against the shapes that made it hard, each taken from a real
 * package in the surveyed corpus rather than invented.
 *
 * The check reads source text without a parser, which is only sound because of two asymmetries it
 * has to get right in OPPOSITE directions: a comment may carry a load-bearing type import, so
 * stripping comments loses real defects; and a template literal may carry generated text that only
 * looks like an import, so reading it invents one. Every case below fails if either is confused,
 * and the pairs are placed together so a "fix" to one that breaks the other cannot pass.
 *
 * Both asymmetries are questions about a specifier's POSITION, so the cases that wrap a comment or
 * a template across lines are the ones that separate a real answer from a line-shaped guess.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json";
import { reviewSelfReferences, reviewShippedFiles, reviewUnreferencedFiles } from "../src/shipped";

const asFiles = (sources: Record<string, string>) =>
  new Map(Object.entries(sources).map(([file, body]) => [file, Buffer.from(body, "utf8")]));

function review(exports: unknown, sources: Record<string, string>, name = "pkg") {
  return reviewSelfReferences({ name, exports } as JsonObject, asFiles(sources)).map(
    (finding) => finding.message,
  );
}

const ONLY_ROOT = { ".": "./index.js" };

it.concurrent("reports a declaration file importing a subpath the package does not export", () => {
  // `@eslint-community/regexpp` ships exactly this: index.d.ts imports `<name>/ast`, and exports
  // carries only "." — so a consumer's checker cannot resolve the package's own types.
  const found = review(ONLY_ROOT, {
    "index.d.ts": 'import * as AST from "pkg/ast";\nexport declare const x: AST.Node;\n',
  });
  expect(found).toHaveLength(1);
  expect(found[0]).toContain('"pkg/ast"');
  expect(found[0]).toContain('"./ast"');

  // The control that proves it measures EXPOSURE and not merely the presence of the name: the
  // identical import through an exported subpath must be silent.
  expect(
    review(
      { ...ONLY_ROOT, "./ast": "./ast.js" },
      {
        "index.d.ts": 'import * as AST from "pkg/ast";\n',
      },
    ),
  ).toEqual([]);
});

it.concurrent("reads a type import inside a comment, and ignores an example of one", () => {
  // Both lines sit in comments. The first is a type a checker resolves (`highlight.js` is caught
  // by exactly this form); the second is documentation prose advertising a subpath the package
  // removed (`rolldown` and `nanoid`). A comment stripper loses the first; no filter at all
  // reports the second. Only the call form is load-bearing inside a comment.
  expect(
    review(ONLY_ROOT, {
      "core.js": '/** @typedef {import("pkg/private").Dict} Dict */\nmodule.exports = {};\n',
    }),
  ).toHaveLength(1);

  expect(
    review(ONLY_ROOT, {
      "index.js":
        "/**\n * Usage:\n * import { customRandom } from 'pkg/format'\n */\nexport const x = 1;\n",
    }),
  ).toEqual([]);
});

it.concurrent("ignores an import this file generates for somebody else's project", () => {
  // `@opentui/core` writes an import statement into a template literal. Reading that as its own
  // import would refuse a publish over text that never executes here.
  expect(
    review(ONLY_ROOT, {
      "codegen.js":
        'const header = `import { thing } from "pkg/runtime-assets"`;\nexport { header };\n',
    }),
  ).toEqual([]);
});

it.concurrent("treats a blocked subpath as unexported, not as declared", () => {
  // `{"./x": null}` is a deliberate refusal to expose the subpath, so a key-presence test gets
  // this backwards and calls the import fine.
  expect(
    review(
      { ...ONLY_ROOT, "./private": null },
      {
        "index.d.ts": 'import type { T } from "pkg/private";\n',
      },
    ),
  ).toHaveLength(1);

  // A pattern key does expose it, and the same import must then be silent.
  expect(
    review(
      { ...ONLY_ROOT, "./*": "./lib/*.js" },
      {
        "index.d.ts": 'import type { T } from "pkg/private";\n',
      },
    ),
  ).toEqual([]);
});

it.concurrent("says nothing about a package with no exports field", () => {
  // Self-reference by name resolves through `exports`; without the field every shipped path is
  // importable anyway, so there is no defect to report.
  const files = new Map([["index.js", Buffer.from('require("pkg/lib/deep");\n', "utf8")]]);
  expect(reviewSelfReferences({ name: "pkg" } as JsonObject, files)).toEqual([]);
});

it.concurrent("reports each distinct specifier once, however many files repeat it", () => {
  // A package whose every declaration imports the same missing subpath produced 9 identical rows
  // in the corpus survey. One finding names the defect; nine name the file count.
  const found = review(ONLY_ROOT, {
    "a.d.ts": 'import type { T } from "pkg/ast";\n',
    "b.d.ts": 'import type { U } from "pkg/ast";\n',
    "c.d.ts": 'import type { V } from "pkg/parser";\n',
  });
  expect(found).toHaveLength(2);
});

it.concurrent("treats a subpath exposed through a fallback array as exposed", () => {
  // `yargs` and `generator-function` both publish their root as `[{…}, "./index.js"]`. The row
  // algebra cannot say what an array resolves to, because the resolvers disagree about it — but
  // every resolver that accepts one resolves the subpath, so refusing to rewrite an array must not
  // become a claim that it reaches nobody.
  expect(
    review(
      { ".": [{ import: "./index.mjs" }, "./index.js"] },
      {
        "test.js": 'var x = require("pkg");\n',
      },
    ),
  ).toEqual([]);

  // The control: the same import against a root that genuinely resolves to nothing.
  expect(
    review({ "./helpers": "./helpers.js" }, { "test.js": 'var x = require("pkg");\n' }),
  ).toHaveLength(1);
});

it.concurrent("ignores a commented-out require, which no checker resolves", () => {
  // `yargs` documents its own usage as `// require('yargs')(…)`. Only `import(...)` is a module
  // reference inside a comment; a commented-out call is dead code.
  expect(review(ONLY_ROOT, { "index.cjs": "// require('pkg/yargs')(process.argv)\n" })).toEqual([]);

  // The control, one character apart in the same position: the form a checker DOES resolve.
  expect(review(ONLY_ROOT, { "index.cjs": '// @typedef {import("pkg/yargs").T}\n' })).toHaveLength(
    1,
  );
});

it.concurrent("reads the position of a specifier, not the shape of its line", () => {
  // Three arrangements the same text takes once a comment or a template wraps across lines. Each
  // one is a false report for any rule that decides from the matched line alone: the first two
  // lines are not the start of their comment, the third line is not the start of its template.
  expect(
    review(ONLY_ROOT, {
      "a.js": '/* Usage:\nimport { x } from "pkg/gone";\n*/\nmodule.exports = {};\n',
      "b.js": 'const port = 1; // see import { x } from "pkg/gone";\n',
      "c.js": 'const code = `\nimport { x } from "pkg/gone";\n`;\n',
    }),
  ).toEqual([]);

  // The control, in the position all three imitate: the identical statement as code.
  expect(review(ONLY_ROOT, { "d.js": 'import { x } from "pkg/gone";\n' })).toHaveLength(1);
});

it.concurrent("stays silent on a file whose scan cannot find its own way out", () => {
  // Telling a regular expression from a division needs a grammar this scanner does not have, so
  // `/a\/*b/` reads as the start of a block comment and swallows the rest of the file. Everything
  // after it then looks like a comment, which is the ONE zone the call form is reported in — so
  // without the end-of-file check this desync refuses a publish over a package that is fine.
  expect(
    review(ONLY_ROOT, {
      "a.js": 'const re = /a\\/*b/;\n// @typedef {import("pkg/gone").T}\n',
    }),
  ).toEqual([]);

  // The control: the same type import in a file the scanner tracks to the end IS reported.
  expect(review(ONLY_ROOT, { "b.js": '// @typedef {import("pkg/gone").T}\n' })).toHaveLength(1);
});

describe.concurrent("a manifest branch pointing at the wrong kind of file", () => {
  const rules = (pkg: JsonObject, sources: Record<string, string>) =>
    reviewShippedFiles(pkg, asFiles(sources)).map((finding) => finding.rule);

  it("reports a types branch that hands a checker something other than declarations", () => {
    // The consumer-visible effect is silent: the checker reads the JavaScript beside it and types
    // the whole package `any`, so nobody sees an error anywhere.
    expect(
      rules({ exports: { ".": { types: "./index.js", default: "./index.js" } } }, {}),
    ).toContain("types-branch-not-declarations");
    // One character of difference, same position: the branch that is correct must stay silent.
    expect(
      rules({ exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }, {}),
    ).toEqual([]);
    // A non-script target is somebody else's concern, not a mislabelled declaration file.
    expect(rules({ exports: { ".": { types: "./schema.json" } } }, {})).toEqual([]);
  });

  it("reports a require branch whose file require() cannot load", () => {
    // Judged by Node's own parser rather than by a pattern, so these are the forms that really
    // throw: ESM syntax, and — on every Node version — top-level await.
    const esm = { "cjs.js": "export const x = 1;\n" };
    expect(rules({ exports: { ".": { require: "./cjs.js" } } }, esm)).toContain(
      "require-branch-is-esm",
    );
    expect(
      rules({ exports: { ".": { require: "./cjs.js" } } }, { "cjs.js": "await fetch(1);\n" }),
    ).toContain("require-branch-is-esm");

    // Controls. Real CommonJS is silent; so is a target absent from the archive, because a missing
    // file is `assertDeclaredFiles`' finding and reporting it twice gives opposite instructions.
    expect(
      rules({ exports: { ".": { require: "./cjs.js" } } }, { "cjs.js": "module.exports = 1;\n" }),
    ).toEqual([]);
    expect(rules({ exports: { ".": { require: "./cjs.js" } } }, {})).toEqual([]);
  });

  it("reports a shebang ended by a carriage return", () => {
    // Invisible in every editor and fatal on every POSIX system, because the kernel passes the CR
    // to execve as part of the interpreter's name.
    expect(rules({}, { "cli.js": "#!/usr/bin/env node\r\nrun();\n" })).toContain(
      "shebang-carriage-return",
    );
    // The same file with the line ending it should have, and a CR that is not on the shebang line.
    expect(rules({}, { "cli.js": "#!/usr/bin/env node\nrun();\n" })).toEqual([]);
    expect(rules({}, { "cli.js": "#!/usr/bin/env node\nrun();\r\n" })).toEqual([]);
    // No shebang at all: a CR on line one of an ordinary module breaks nothing.
    expect(rules({}, { "lib.js": "const a = 1;\r\n" })).toEqual([]);
  });
});

describe.concurrent("files the package ships but nothing reaches", () => {
  const ROOT = { ".": "./index.js" };
  const review = (
    sources: Record<string, string>,
    allow: readonly string[] = [],
    exports: unknown = ROOT,
  ) => reviewUnreferencedFiles({ name: "pkg", exports } as JsonObject, asFiles(sources), allow);
  const rules = (...args: Parameters<typeof review>) => review(...args).map((f) => f.rule);

  it("refuses an import that only a case-folding filesystem resolves", () => {
    // The author's own machine resolves it, every Linux consumer's does not, and the package
    // installs cleanly either way — so nothing but this reports it before the version is burned.
    expect(
      rules({ "index.js": 'import "./Utils.js";\n', "utils.js": "export const u = 1;\n" }),
    ).toContain("import-case-mismatch");
    // The control one character apart: the correct casing is silent, and the file counts as
    // reached — a rule that reported it as dead weight too would give opposite instructions.
    expect(
      rules({ "index.js": 'import "./utils.js";\n', "utils.js": "export const u = 1;\n" }),
    ).toEqual([]);
  });

  it("never invents that refusal from text the runtime does not execute", () => {
    // This is the whole measured false-positive population, and the reason position comes from
    // `lexical.ts` rather than from the matched line. Each of these mentions a shipped file in the
    // wrong case; none of them is an import, so each must stay silent while the file stays reached.
    const utils = { "utils.js": "export const u = 1;\n" };
    for (const mention of [
      'import "./utils.js"; // see also ./Utils.js\n',
      'import "./utils.js";\n/** Re-exported from ./Utils.js */\n',
      'import "./utils.js";\nconst gen = `import "./Utils.js";`;\n',
      'import "./utils.js";\nconst gen = `pre${`import "./Utils.js";`}post`;\n',
    ])
      expect(rules({ "index.js": mention, ...utils })).toEqual([]);
  });

  it("follows an extensionless import into the declaration file it names", () => {
    // `import "./types"` with `types.d.ts` shipped is the classic resolution style, which predates
    // the `.mts`/`.cts` family. A declaration is exempt from the dead-weight rule by nature, so the
    // consequence sits one hop further out: a file reached only THROUGH that declaration stops
    // being reachable at all, and the rule then tells the author to delete something their own
    // types import.
    const sources = {
      "index.js": 'import "./types";\n',
      "types.d.ts": 'import "./helper.js";\nexport type T = number;\n',
      "helper.js": "export const h = 1;\n".repeat(80),
    };
    expect(rules(sources)).toEqual([]);
    // The control in the same position: the identical package whose declaration imports nothing
    // leaves `helper.js` genuinely unreached, so the silence above measures the extensionless hop
    // rather than a helper the closure arrived at some other way.
    expect(rules({ ...sources, "types.d.ts": "export type T = number;\n" })).toContain(
      "unreferenced-file",
    );
  });

  it("reports a file nothing reaches, and stops the run over it", () => {
    const found = review({ "index.js": "export const a = 1;\n", "orphan.js": "dead\n".repeat(80) });
    expect(found.map((f) => f.rule)).toEqual(["unreferenced-file"]);
    // Waste that aborts anyway, carried as data on the finding rather than as a branch on its name.
    expect(found[0]?.consequence).toBe("waste");
    expect(found[0]?.rulesAbort).toBe(true);
    // Named exactly, because the message's whole value is the line the author pastes to resolve it.
    expect(found[0]?.message).toContain("orphan.js");
  });

  it("stays silent on the categories an import graph has no standing over", () => {
    // Each of these is reached by something the closure cannot see, and the failure is asymmetric:
    // deleting a nested package.json on this rule's advice breaks how the directory loads.
    for (const orphan of [
      "README.md",
      "LICENSE",
      "dist/cjs/package.json",
      "index.d.ts",
      "prebuilds/linux-x64/node.napi.node",
      "styles/main.css",
      "bundle.js.LICENSE.txt",
    ])
      expect(rules({ "index.js": "export const a = 1;\n", [orphan]: "x\n".repeat(80) })).toEqual(
        [],
      );
  });

  it("takes the author's word for a file the graph cannot see", () => {
    const orphan = { "index.js": "export const a = 1;\n", "data/table.js": "x\n".repeat(80) };
    expect(rules(orphan)).toContain("unreferenced-file");
    expect(rules(orphan, ["data/"])).toEqual([]);
    expect(rules(orphan, ["data/table.js"])).toEqual([]);
  });

  it("says nothing at all about a package without exports", () => {
    // Without the field every shipped path is a public entry point a consumer may already require,
    // so "nothing reaches this" is not a true statement about it. The manifest is built here rather
    // than through the helper, because a default parameter cannot express an ABSENT key.
    const sources = asFiles({ "index.js": "export const a = 1;\n", "orphan.js": "x\n".repeat(80) });
    expect(reviewUnreferencedFiles({ name: "pkg" } as JsonObject, sources, [])).toEqual([]);
    // The control: the identical package with the field present does report it, so the silence
    // above measures the gate and not an orphan the closure happened to reach.
    expect(
      reviewUnreferencedFiles({ name: "pkg", exports: ROOT } as JsonObject, sources, []),
    ).toHaveLength(1);
  });
});
