/**
 * Falsifies the self-import check against the shapes that made it hard, each taken from a real
 * package in the surveyed corpus rather than invented.
 *
 * The check reads source text without a parser, which is only sound because of two asymmetries it
 * has to get right in OPPOSITE directions: a comment may carry a load-bearing type import, so
 * stripping comments loses real defects; and a template literal may carry generated text that only
 * looks like an import, so reading it invents one. Every case below fails if either is confused,
 * and the pairs are placed together so a "fix" to one that breaks the other cannot pass.
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
