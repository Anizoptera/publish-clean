/**
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
import { expect, it } from "vitest";
import type { JsonObject } from "../src/json";
import { reviewSelfReferences } from "../src/shipped";

function review(exports: unknown, sources: Record<string, string>, name = "pkg") {
  const files = new Map(
    Object.entries(sources).map(([file, body]) => [file, Buffer.from(body, "utf8")]),
  );
  return reviewSelfReferences({ name, exports } as JsonObject, files).map(
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
