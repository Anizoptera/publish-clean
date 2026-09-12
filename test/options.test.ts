// Refuse unchecked artifact selection and compare accepted flag values with npm's own parser.
import { expect, it } from "vitest";
import { parseOptions } from "../src/options";
import { PublishCleanError } from "../src/error";
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

// A mistyped flag is a condition this tool explains, not a defect it leaks. `parseArgs` answers one
// with a stack trace through `node:internal`, and with advice to move the flag after `--` — which
// here forwards it to `npm publish`, the one step nobody can take back.
it.concurrent.each([["--stict"], ["-x"], ["--strict=maybe"]])(
  "names the flags it accepts when given %j, rather than the parser's stack",
  (...args) => {
    let thrown: unknown;
    try {
      parseOptions(args);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PublishCleanError);
    const { message } = thrown as PublishCleanError;
    expect(message).toContain(args[0]!.split("=")[0]);
    expect(message).not.toContain("place it at the end");
    // A flag none of these inputs names, so the list is being read from the parser's own table.
    expect(message).toContain("--tarball-out");
  },
);

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
