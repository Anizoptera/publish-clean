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
  expect(healed.stderr).toContain("[healed]");

  // --no-heal withholds the rewrite and keeps the finding: the artifact is untouched, and the
  // message must stop claiming a repair it no longer carries.
  const reported = await check(pkg, INDEX, ["--dry-run", "--no-heal"]);
  expect(reported.status).toBe(0);
  expect(reported.published?.exports).toEqual({
    ".": { node: "./index.js", default: "./index.js" },
  });
  expect(reported.stderr).toContain("exports-inert-condition");
  expect(reported.stderr).not.toContain("[healed]");
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
