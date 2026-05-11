import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CLI = path.resolve("dist/cli.js");

interface Fixture {
  dir: string;
  root: string;
}

function runCli(
  args: readonly string[],
  cwd: string,
  env?: Record<string, string>,
): SpawnSyncReturns<string> {
  return spawnSync("node", [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function fixture(
  pkg: Record<string, unknown>,
  files: Record<string, string>,
): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "publish-clean-test-"));
  const dir = path.join(root, "pkg");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await writeFile(
    path.join(root, "pnpm-workspace.yaml"),
    "packages:\n  - pkg\n",
  );
  return { dir, root };
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

function extractedPath(stdout: string): string {
  const match = /\[dry-run\] Extracted package at: (.+)$/m.exec(stdout);
  if (!match?.[1]) throw new Error(`missing dry-run path in ${stdout}`);
  return match[1].trim();
}

describe("publish-clean", () => {
  it("strips author-only manifest fields and validates declared files", async () => {
    const fx = await fixture(
      {
        name: "fixture-ok",
        version: "1.0.0",
        type: "module",
        files: ["index.js"],
        exports: "./index.js",
        scripts: { build: "tsc", postinstall: "node index.js" },
        devDependencies: { typescript: "^5.0.0" },
      },
      { "index.js": "export const ok = true;\n" },
    );
    try {
      const result = runCli(
        ["--dry-run", "--no-git-checks", fx.dir],
        process.cwd(),
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const pkg = JSON.parse(
        await readFile(
          path.join(extractedPath(result.stdout), "package.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(pkg.devDependencies).toBeUndefined();
      expect(pkg.scripts).toEqual({ postinstall: "node index.js" });
    } finally {
      await cleanup(fx.root);
    }
  });

  it("refuses critical leaked files even when suspicious checks are skipped", async () => {
    const fx = await fixture(
      { name: "fixture-leak", version: "1.0.0", files: ["index.js", ".env"] },
      { "index.js": "module.exports = 1;\n", ".env": "TOKEN=secret\n" },
    );
    try {
      const result = runCli(
        ["--dry-run", "--no-git-checks", "--skip-file-check", fx.dir],
        process.cwd(),
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Critical files must not be published");
    } finally {
      await cleanup(fx.root);
    }
  });

  it("fails unresolved monorepo-only dependency protocols", async () => {
    const fx = await fixture(
      {
        name: "fixture-protocol",
        version: "1.0.0",
        files: ["index.js"],
        dependencies: { bad: "link:../bad" },
      },
      { "index.js": "module.exports = 1;\n" },
    );
    try {
      const result = runCli(
        ["--dry-run", "--no-git-checks", fx.dir],
        process.cwd(),
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "unresolved monorepo-only dependency specs",
      );
      expect(result.stderr).toContain("uses pnpm pack intentionally");
    } finally {
      await cleanup(fx.root);
    }
  });

  it("warns when invoked from a non-pnpm lifecycle", async () => {
    const fx = await fixture(
      { name: "fixture-user-agent", version: "1.0.0", files: ["index.js"] },
      { "index.js": "module.exports = 1;\n" },
    );
    try {
      const result = runCli(
        ["--dry-run", "--no-git-checks", fx.dir],
        process.cwd(),
        {
          npm_config_user_agent: "npm/11.0.0 node/v24",
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain("uses pnpm pack intentionally");
      expect(result.stderr).toContain("npm/11.0.0");
    } finally {
      await cleanup(fx.root);
    }
  });
});
