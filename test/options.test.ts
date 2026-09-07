// Refuse unchecked artifact selection and compare accepted flag values with npm's own parser.
import { expect, it } from "vitest";
import { parseOptions } from "../src/options";
import { run } from "../src/command";
import { wantsTrustedPublish } from "../src/trusted-publish";

it.concurrent.each([
  ["."],
  ["other.tgz"],
  ["--workspace", "."],
  ["--workspaces"],
  ["-w", "."],
  ["--include-workspace-root"],
  ["--prefix", "elsewhere"],
  ["--", "."],
  ["--tag"],
  ["--tag=--workspace"],
  ["--provenance=maybe"],
  ["--registry=https://secret@example.test"],
])("rejects unsafe publication arguments %j", (...args) => {
  expect(() => parseOptions(["--", ...args])).toThrow();
});

it.concurrent.each([
  [["--provenance"], true],
  [["--provenance", "false"], false],
  [["--provenance=true", "--no-provenance"], false],
  [["--provenance=false", "--no-provenance=false"], true],
] as const)("matches npm's boolean precedence for %j", async (args, expected) => {
  const { publishArgs } = parseOptions(["--", ...args]);
  const actual = await run("npm", ["config", "get", "provenance", ...publishArgs], process.cwd());
  expect(actual.trim()).toBe(String(expected));
  expect(wantsTrustedPublish({ publishConfig: { provenance: !expected } }, publishArgs, {})).toBe(
    expected,
  );
});
