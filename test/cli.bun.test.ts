import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const roots: string[] = [];
const cli = path.resolve("dist/cli.js");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makePackage(pkg: Record<string, unknown>, files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "publish-clean-bun-test-"));
  roots.push(root);
  const dir = path.join(root, "pkg");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - pkg\n");
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return dir;
}

async function run(args: string[]) {
  const proc = Bun.spawn(["node", cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stderr, status, stdout };
}

describe("publish-clean under bun test", () => {
  test("rejects missing declared export file", async () => {
    const dir = await makePackage(
      {
        name: "fixture-missing-export",
        version: "1.0.0",
        files: ["index.js"],
        exports: "./missing.js",
      },
      { "index.js": "export const ok = true;\n" },
    );
    const result = await run(["--dry-run", "--no-git-checks", dir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Manifest declares files missing");
  });
});
