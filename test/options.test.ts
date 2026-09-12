// Refuse unchecked artifact selection and compare accepted flag values with npm's own parser.
import { expect, it } from "vitest";
import { HELP, parseOptions } from "../src/options";
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

// Help text is documentation, never the parser, and nothing else makes the two agree: a flag added
// to one and not the other is invisible until someone types it. The refusal above prints the
// parser's own table, so this reads the real list rather than a second copy of it.
it.concurrent("documents every flag it accepts", () => {
  let message = "";
  try {
    parseOptions(["--no-such-flag"]);
  } catch (error) {
    ({ message } = error as PublishCleanError);
  }
  const accepted = [...message.matchAll(/--[a-z][a-z-]+/g)]
    .map(([flag]) => flag)
    .filter((flag) => flag !== "--no-such-flag");
  // Controls on the extraction itself: a regex that stopped matching would pass every check below.
  expect(accepted.length).toBeGreaterThan(5);
  expect(accepted).toContain("--verify-only");
  for (const flag of accepted) expect(HELP).toContain(flag);
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
