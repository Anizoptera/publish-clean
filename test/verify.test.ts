/**
 * The verification surface, exercised through the built CLI against real pnpm-packed tarballs.
 *
 * Nothing here is stubbed: each case packs a real package and reads the manifest this tool would
 * have uploaded, because the whole claim of this tool is that it judges the bytes that ship. A
 * unit test against an in-memory manifest cannot distinguish "the rule is right" from "the rule
 * never ran".
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const CLI = path.resolve("dist/cli.js");

function runCli(args: readonly string[], cwd: string) {
  return new Promise<{ status: null | number; stderr: string; stdout: string }>(
    (resolve, reject) => {
      const child = spawn("node", [CLI, ...args], { cwd, timeout: 30_000, killSignal: "SIGKILL" });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stderr, stdout }));
    },
  );
}

async function fixture(pkg: Record<string, unknown>, files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "publish-clean-verify-"));
  const dir = path.join(root, "pkg");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - pkg\n");
  return { dir, root };
}

/** Runs one package through the CLI and returns what the run said and what it would publish. */
async function check(
  pkg: Record<string, unknown>,
  files: Record<string, string>,
  args: readonly string[],
) {
  const fx = await fixture(pkg, files);
  try {
    const result = await runCli([...args, "--no-git-checks"], fx.dir);
    const printed = /\[dry-run\] cleaned package\.json:\n([\s\S]*)$/.exec(result.stdout)?.[1];
    return {
      ...result,
      published: printed === undefined ? null : (JSON.parse(printed) as Record<string, unknown>),
    };
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
}

const SOUND = {
  name: "fixture-verify",
  version: "1.0.0",
  type: "module",
  files: ["index.js"],
  exports: { ".": "./index.js" },
};
const INDEX = { "index.js": "export const ok = true;\n" };

it.concurrent("checks a private package that publishing refuses outright", async () => {
  // The ONE guard verification skips. Everything else must apply identically, or a package
  // checked before it goes public was checked by different rules than the ones it will face.
  const priv = { ...SOUND, private: true };
  await expect(check(priv, INDEX, ["verify"])).resolves.toMatchObject({ status: 0 });
  await expect(check(priv, INDEX, ["--verify-only"])).resolves.toMatchObject({ status: 0 });

  const refused = await check(priv, INDEX, ["--dry-run"]);
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain("private: true");
});

it.concurrent("gives every reason the source cannot be packed, not the first one", async () => {
  // These run before anything is packed, so they cannot travel with the findings — there is no
  // artifact for a finding to be about. They are still independent reasons, each costing a full
  // re-run to discover, so an author must not have to fix them one per run to find the next.
  const { files: _declared, ...undeclared } = SOUND;
  const refused = await check({ ...undeclared, private: true }, INDEX, ["--dry-run"]);
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain("private: true");
  expect(refused.stderr).toContain('"files"');
});

it.concurrent("reports an unrecognised field in the same shape as every other finding", async () => {
  // One report, one format. An agent or a human scanning output should not have to learn that
  // some advice arrives as a labelled block and some as a bare paragraph printed earlier, and a
  // rule with no id cannot be grepped, silenced or counted like its neighbours.
  const odd = { ...SOUND, someToolConfig: { threshold: 5 } };
  const result = await check(odd, INDEX, ["verify"]);
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("[warning] unrecognized-field");
  expect(result.stderr).toContain("someToolConfig");
  // The advice is the whole point: both resolutions must survive the move into the model.
  expect(result.stderr).toContain(`"devFields": ["someToolConfig"]`);
  expect(result.stderr).toContain(`"keepFields": ["someToolConfig"]`);
});

it.concurrent("says whether it passed, rather than going silent after a warning", async () => {
  // `verify` exists to be read. Findings then silence cannot be told apart from findings then a
  // crash, and a clean run printing nothing at all reads as a tool that never ran.
  const clean = await check(SOUND, INDEX, ["verify"]);
  expect(clean.status).toBe(0);
  expect(clean.stderr).toContain("publish-clean: no findings");

  const warned = await check({ ...SOUND, someToolConfig: {} }, INDEX, ["verify"]);
  expect(warned.status).toBe(0);
  expect(warned.stderr).toMatch(/1 finding[^s].*stops a publish/);
});

it.concurrent("keeps --guard-only working and says what replaces it", async () => {
  // Deprecating a flag that stops existing scripts is a migration nobody asked for; this one is
  // in this repository's own prepublishOnly.
  const result = await check(SOUND, INDEX, ["--guard-only"]);
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("--guard-only is deprecated");
  expect(result.stderr).toContain("publish-clean verify");
});

it.concurrent("repairs a provably inert condition in the manifest it publishes", async () => {
  const pkg = { ...SOUND, exports: { ".": { node: "./index.js", default: "./index.js" } } };
  const healed = await check(pkg, INDEX, ["--dry-run"]);
  expect(healed.status).toBe(0);
  expect(healed.published?.exports).toEqual({ ".": "./index.js" });
  expect(healed.stderr).toContain("exports-inert-condition");
  expect(healed.stderr).toContain("repaired in the published artifact, not in your source");

  // --no-heal withholds the rewrite and keeps the finding: the artifact is untouched, and the
  // message must stop claiming a repair it no longer carries.
  const reported = await check(pkg, INDEX, ["--dry-run", "--no-heal"]);
  expect(reported.status).toBe(0);
  expect(reported.published?.exports).toEqual({
    ".": { node: "./index.js", default: "./index.js" },
  });
  expect(reported.stderr).toContain("exports-inert-condition");
  expect(reported.stderr).not.toContain("repaired");
});

it.concurrent("--strict promotes a warning but never a repair", async () => {
  // A map of environment names with no `default` leaves an edge runtime with no branch. It is a
  // warning by default because a quarter of published packages are shaped that way deliberately.
  const hole = {
    ...SOUND,
    files: ["index.js", "browser.js"],
    exports: { ".": { node: "./index.js", browser: "./browser.js" } },
  };
  const files = { ...INDEX, "browser.js": "export const ok = true;\n" };
  const lenient = await check(hole, files, ["--dry-run"]);
  expect(lenient.status).toBe(0);
  expect(lenient.stderr).toContain("exports-unresolvable");

  const strict = await check(hole, files, ["--dry-run", "--strict"]);
  expect(strict.status).not.toBe(0);
  expect(strict.stderr).toContain("Refusing to publish");

  // The repaired case stays green under --strict. A finding this run already fixed describes an
  // artifact that is now correct, so promoting it would refuse a publish for nothing.
  const repaired = await check(
    { ...SOUND, exports: { ".": { node: "./index.js", default: "./index.js" } } },
    INDEX,
    ["--dry-run", "--strict"],
  );
  expect(repaired.status).toBe(0);
});

it.concurrent("refuses to publish files nothing in the package reaches", async () => {
  // Ruled an error outright, so it must stop the run with no --strict, and the message must
  // carry the exact line that resolves it.
  const fat = { ...SOUND, files: ["index.js", "orphan.js"] };
  const files = { ...INDEX, "orphan.js": "export const unused = true;\n" };
  const refused = await check(fat, files, ["--dry-run"]);
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain("orphan.js");
  expect(refused.stderr).toContain(`"allowUnreferenced": ["orphan.js"]`);

  // Declaring it is one line, and the run goes green — a file genuinely used in a way no import
  // records must not cost its author a publish.
  const declared = await check(
    { ...fat, "publish-clean": { allowUnreferenced: ["orphan.js"] } },
    files,
    ["--dry-run"],
  );
  expect(declared.status).toBe(0);

  // The same file reached by an import is never reported, which is what proves the rule is
  // measuring reachability rather than merely listing files.
  const imported = await check(fat, { ...files, "index.js": 'export * from "./orphan.js";\n' }, [
    "--dry-run",
  ]);
  expect(imported.status).toBe(0);
});

it.concurrent("refuses an import only a case-folding filesystem can resolve", async () => {
  // The author's machine folds case, so this package runs for them and breaks for a consumer whose
  // filesystem does not. Before this rule the shape was not silent — it was WORSE than silent: the
  // imported file was never reached, so the dead-weight rule called it unreachable and told the
  // author to delete a file their own code imports, which makes the break permanent.
  //
  // No Unicode-form case here on purpose: the fixture's filename would be normalised by whatever
  // filesystem the runner has, and this suite runs on Linux and Windows too. That axis is pinned
  // in the unit lane, where the file list is constructed rather than written to a disk.
  const pkg = { ...SOUND, files: ["index.js", "helper.js"] };
  const helper = { "helper.js": "export const ok = true;\n" };

  const folded = await check(pkg, { ...helper, "index.js": 'export * from "./Helper.js";\n' }, [
    "--dry-run",
  ]);
  expect(folded.status).not.toBe(0);
  expect(folded.stderr).toContain("import-case-mismatch");
  expect(folded.stderr).toContain("helper.js");
  // Referenced wrongly is not the same as unreferenced. Reporting both would hand the author two
  // findings with opposite instructions, and the destructive one is the easier to act on.
  expect(folded.stderr).not.toContain("allowUnreferenced");

  // Control: the identical package with the spelling corrected must pass, which is what proves the
  // rule reads the mismatch rather than the mere presence of a second file.
  const exact = await check(pkg, { ...helper, "index.js": 'export * from "./helper.js";\n' }, [
    "--dry-run",
  ]);
  expect(exact.status).toBe(0);

  // The specifier pattern deliberately matches inside comments, which is safe for the dead-weight
  // rule because a spurious match only suppresses a report. This finding reverses that direction,
  // so the same match would invent one and refuse a publish that is perfectly correct. Prose
  // naming a path must therefore be read as prose.
  const mentioned = await check(
    pkg,
    // The prose must carry a specifier TRIGGER (`from "`), or the pattern never matches and the
    // case tests nothing at all. A documentation example of an import is the measured
    // false-positive population for the sibling scan in this same file.
    {
      ...helper,
      "index.js": '// previously re-exported from "./Helper.js"\nexport const ok = true;\n',
    },
    ["--dry-run"],
  );
  expect(mentioned.stderr).not.toContain("import-case-mismatch");

  // Declarations import their siblings as `./Types.js` while the file shipped is `types.d.ts` —
  // the commonest shape in a typed package, and one a checker resolves through its own rules. A
  // resolver that stops at the `.js`/`.ts` swap finds no near match here and reports nothing, so
  // the rule would be silent exactly where most packages live.
  const types = await check(
    {
      ...SOUND,
      files: ["index.js", "index.d.ts", "types.d.ts"],
      exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
    },
    {
      ...INDEX,
      "index.d.ts": 'export * from "./Types.js";\nexport declare const ok: boolean;\n',
      "types.d.ts": "export type A = 1;\n",
    },
    ["--dry-run"],
  );
  expect(types.status).not.toBe(0);
  expect(types.stderr).toContain("import-case-mismatch");
  expect(types.stderr).toContain("types.d.ts");

  // A specifier naming nothing at all must NOT be claimed as a misspelling: no folded name matches
  // it, so it stays an unresolved import and the file it never reaches stays dead weight.
  const absent = await check(pkg, { ...helper, "index.js": 'export * from "./missing.js";\n' }, [
    "--dry-run",
  ]);
  expect(absent.stderr).not.toContain("import-case-mismatch");
  expect(absent.stderr).toContain("allowUnreferenced");
});

it.concurrent("refuses a package whose own declarations import an unexported subpath", async () => {
  // The shape `@eslint-community/regexpp` publishes. It has to be proven through a real tarball:
  // the defect exists only because resolution goes through `exports`, and in the source tree the
  // same import resolves by path, which is exactly why the author never sees it.
  const pkg = {
    ...SOUND,
    files: ["index.js", "index.d.ts", "ast.d.ts"],
    exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
  };
  const files = {
    ...INDEX,
    "ast.d.ts": "export type Node = { kind: string };\n",
    "index.d.ts":
      'import type { Node } from "fixture-verify/ast";\nexport declare const n: Node;\n',
  };
  const refused = await check(pkg, files, ["--dry-run"]);
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain("self-import-not-exported");
  expect(refused.stderr).toContain('"./ast"');

  // Exporting the subpath is the fix the message names, and it must actually clear the finding.
  const fixed = await check(
    {
      ...pkg,
      exports: { ...pkg.exports, "./ast": { types: "./ast.d.ts", default: "./index.js" } },
    },
    files,
    ["--dry-run"],
  );
  expect(fixed.status).toBe(0);
});

it.concurrent("reports a types branch that does not resolve to declarations", async () => {
  const lying = {
    ...SOUND,
    files: ["index.js", "shim.js"],
    exports: { ".": { types: "./shim.js", default: "./index.js" } },
  };
  const result = await check(lying, { ...INDEX, "shim.js": "export const x = 1;\n" }, [
    "--dry-run",
  ]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("types-branch-not-declarations");

  // The branches must DIFFER for this to be a defect at all. A `types` key resolving to the same
  // file as `default` is merely inert — a checker reads that file either way — so the repair
  // deletes the key and the complaint correctly disappears with it.
  const harmless = await check(
    { ...SOUND, exports: { ".": { types: "./index.js", default: "./index.js" } } },
    INDEX,
    ["--dry-run"],
  );
  expect(harmless.status).toBe(0);
  expect(harmless.published?.exports).toEqual({ ".": "./index.js" });
});
