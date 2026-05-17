import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
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

function finalTarballPath(stdout: string): string {
  const match = /\[dry-run\] Final tarball at: (.+)$/m.exec(stdout);
  if (!match?.[1]) throw new Error(`missing final tarball path in ${stdout}`);
  return match[1].trim();
}

async function cleanupExtracted(stdout: string): Promise<void> {
  await cleanup(path.dirname(extractedPath(stdout)));
}

async function writeShim(file: string, script: string): Promise<void> {
  await writeFile(file, script);
  await chmod(file, 0o755);
}

function readTarballFile(tarball: string, file: string): string {
  const result = spawnSync("tar", ["xOzf", tarball, `package/${file}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

describe("publish-clean", () => {
  it("prints all supported options in help", () => {
    const result = runCli(["--help"], process.cwd());
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("--no-git-checks");
    expect(result.stdout).toContain("npm-publish-args");
  });

  it("rejects unknown CLI options before publish args", () => {
    const result = runCli(["--dryrun"], process.cwd());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown option");
  });

  it("rejects extra package positionals before publish args", async () => {
    const fx = await fixture(
      {
        name: "fixture-extra-positionals",
        version: "1.0.0",
        files: ["index.js"],
      },
      { "index.js": "module.exports = 1;\n" },
    );
    try {
      const result = runCli(
        ["--dry-run", "--no-git-checks", fx.dir, "stray"],
        process.cwd(),
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Unexpected positional arguments");
    } finally {
      await cleanup(fx.root);
    }
  });

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
      await cleanupExtracted(result.stdout);
    } finally {
      await cleanup(fx.root);
    }
  });

  it("does not treat publish args after -- as the package directory", async () => {
    const fx = await fixture(
      { name: "fixture-publish-args", version: "1.0.0", files: ["index.js"] },
      { "index.js": "module.exports = 1;\n" },
    );
    try {
      const result = runCli(
        ["--dry-run", "--no-git-checks", "--", "--tag", "next"],
        fx.dir,
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("[dry-run] Extracted package at:");
      await cleanupExtracted(result.stdout);
    } finally {
      await cleanup(fx.root);
    }
  });

  it("reports and keeps the final npm tarball in dry-run output", async () => {
    const fx = await fixture(
      { name: "fixture-final-tarball", version: "1.0.0", files: ["index.js"] },
      { "index.js": "module.exports = 1;\n" },
    );
    try {
      const result = runCli(
        ["--dry-run", "--no-git-checks", fx.dir],
        process.cwd(),
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(finalTarballPath(result.stdout)).toMatch(/\.tgz$/);
      await cleanupExtracted(result.stdout);
    } finally {
      await cleanup(fx.root);
    }
  });

  it("keeps the final npm tarball manifest cleaned", async () => {
    const fx = await fixture(
      {
        name: "fixture-final-manifest",
        version: "1.0.0",
        files: ["index.js"],
        devDependencies: { typescript: "^5.0.0" },
        scripts: { build: "tsc" },
      },
      { "index.js": "module.exports = 1;\n" },
    );
    try {
      const result = runCli(
        ["--dry-run", "--no-git-checks", fx.dir],
        process.cwd(),
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const pkg = JSON.parse(
        readTarballFile(finalTarballPath(result.stdout), "package.json"),
      ) as Record<string, unknown>;
      expect(pkg.devDependencies).toBeUndefined();
      expect(pkg.scripts).toBeUndefined();
      await cleanupExtracted(result.stdout);
    } finally {
      await cleanup(fx.root);
    }
  });

  it("parses pnpm and npm pack JSON output even when npm config requests JSON", async () => {
    const fx = await fixture(
      { name: "fixture-json-pack", version: "1.0.0", files: ["index.js"] },
      { "index.js": "module.exports = 1;\n" },
    );
    try {
      const result = runCli(
        ["--dry-run", "--no-git-checks", fx.dir],
        process.cwd(),
        { NPM_CONFIG_JSON: "true" },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(finalTarballPath(result.stdout)).toMatch(/\.tgz$/);
      await cleanupExtracted(result.stdout);
    } finally {
      await cleanup(fx.root);
    }
  });

  it("publishes the final npm tarball with npm, not the cleaned directory with pnpm", async () => {
    const fx = await fixture(
      { name: "fixture-npm-publish", version: "1.0.0", files: ["index.js"] },
      { "index.js": "module.exports = 1;\n" },
    );
    const bin = path.join(fx.root, "bin");
    const log = path.join(fx.root, "commands.log");
    const realNpm = spawnSync("which", ["npm"], {
      encoding: "utf8",
    }).stdout.trim();
    try {
      await mkdir(bin);
      await writeShim(
        path.join(bin, "npm"),
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "11.5.1"; exit 0; fi
if [ "$1" = "pack" ]; then
  shift
  exec "$REAL_NPM" pack "$@"
fi
if [ "$1" = "publish" ]; then
  printf '%s\\n' "$*" > "${log}"
  exit 0
fi
echo "unexpected npm $*" >&2
exit 1
`,
      );
      const result = runCli(
        [
          "--no-git-checks",
          fx.dir,
          "--",
          "--access",
          "public",
          "--tag",
          "latest",
        ],
        process.cwd(),
        { PATH: `${bin}:${process.env.PATH ?? ""}`, REAL_NPM: realNpm },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const published = await readFile(log, "utf8");
      expect(published).toContain("publish ");
      expect(published).toContain(".tgz");
      expect(published).toContain("--tag latest");
    } finally {
      await cleanup(fx.root);
    }
  });

  it("rejects provenance publish when npm is too old for trusted publishing", async () => {
    const fx = await fixture(
      { name: "fixture-old-npm", version: "1.0.0", files: ["index.js"] },
      { "index.js": "module.exports = 1;\n" },
    );
    const bin = path.join(fx.root, "bin");
    try {
      await mkdir(bin);
      await writeShim(
        path.join(bin, "npm"),
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "11.5.0"; exit 0; fi
echo "unexpected npm $*" >&2
exit 1
`,
      );
      const result = runCli(
        ["--no-git-checks", fx.dir, "--", "--provenance"],
        process.cwd(),
        { PATH: `${bin}:${process.env.PATH ?? ""}` },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("requires npm 11.5.1");
    } finally {
      await cleanup(fx.root);
    }
  });

  it("treats publishConfig provenance as trusted publishing", async () => {
    const fx = await fixture(
      {
        name: "fixture-publish-config-provenance",
        version: "1.0.0",
        files: ["index.js"],
        publishConfig: { provenance: true },
      },
      { "index.js": "module.exports = 1;\n" },
    );
    const bin = path.join(fx.root, "bin");
    try {
      await mkdir(bin);
      await writeShim(
        path.join(bin, "npm"),
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "11.5.0"; exit 0; fi
echo "unexpected npm $*" >&2
exit 1
`,
      );
      const result = runCli(["--no-git-checks", fx.dir], process.cwd(), {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("requires npm 11.5.1");
    } finally {
      await cleanup(fx.root);
    }
  });

  it("rejects GitHub trusted publishing when repository metadata does not match", async () => {
    const fx = await fixture(
      {
        name: "fixture-bad-repo",
        version: "1.0.0",
        files: ["index.js"],
        repository: {
          type: "git",
          url: "git+https://github.com/Other/repo.git",
        },
      },
      { "index.js": "module.exports = 1;\n" },
    );
    const bin = path.join(fx.root, "bin");
    const realNpm = spawnSync("which", ["npm"], {
      encoding: "utf8",
    }).stdout.trim();
    try {
      await mkdir(bin);
      await writeShim(
        path.join(bin, "npm"),
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "11.5.1"; exit 0; fi
if [ "$1" = "pack" ]; then shift; exec "$REAL_NPM" pack "$@"; fi
if [ "$1" = "publish" ]; then exit 0; fi
echo "unexpected npm $*" >&2
exit 1
`,
      );
      const result = runCli(
        ["--no-git-checks", fx.dir, "--", "--provenance"],
        process.cwd(),
        {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          REAL_NPM: realNpm,
          GITHUB_ACTIONS: "true",
          GITHUB_REPOSITORY: "Anizoptera/publish-clean",
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("repository.url must match");
    } finally {
      await cleanup(fx.root);
    }
  });

  it("reports the malformed JSON file path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "publish-clean-test-"));
    const dir = path.join(root, "pkg");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), "{\n");
    try {
      const result = runCli(
        ["--dry-run", "--no-git-checks", dir],
        process.cwd(),
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(path.join(dir, "package.json"));
    } finally {
      await cleanup(root);
    }
  });

  it("surfaces package-manager diagnostics emitted on stdout", async () => {
    const fx = await fixture(
      { name: "bad name", version: "1.0.0", files: ["index.js"] },
      { "index.js": "module.exports = 1;\n" },
    );
    try {
      const result = runCli(
        ["--dry-run", "--no-git-checks", fx.dir],
        process.cwd(),
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("ERR_PNPM_INVALID_PACKAGE_NAME");
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

  it("refuses critical leaked files in nested package paths", async () => {
    const fx = await fixture(
      {
        name: "fixture-nested-leak",
        version: "1.0.0",
        files: ["index.js", "config/.npmrc"],
      },
      { "index.js": "module.exports = 1;\n", "config/.npmrc": "//token\n" },
    );
    try {
      const result = runCli(
        ["--dry-run", "--no-git-checks", "--skip-file-check", fx.dir],
        process.cwd(),
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("config/.npmrc");
    } finally {
      await cleanup(fx.root);
    }
  });

  it("removes temporary package extraction after validation failure", async () => {
    const fx = await fixture(
      {
        name: "fixture-temp-cleanup",
        version: "1.0.0",
        files: ["index.js", ".env"],
      },
      { "index.js": "module.exports = 1;\n", ".env": "TOKEN=secret\n" },
    );
    const temp = await mkdtemp(path.join(tmpdir(), "publish-clean-tmp-"));
    try {
      const result = runCli(
        ["--dry-run", "--no-git-checks", "--skip-file-check", fx.dir],
        process.cwd(),
        { TMPDIR: temp },
      );
      expect(result.status).not.toBe(0);
      const leftovers = (await readdir(temp)).filter((name) =>
        name.startsWith("publish-clean-"),
      );
      expect(leftovers).toEqual([]);
      expect(result.stdout).not.toContain("Final tarball");
    } finally {
      await cleanup(fx.root);
      await cleanup(temp);
    }
  });

  it("removes temporary package extraction after guard-only success", async () => {
    const fx = await fixture(
      { name: "fixture-guard-cleanup", version: "1.0.0", files: ["index.js"] },
      { "index.js": "module.exports = 1;\n" },
    );
    const temp = await mkdtemp(path.join(tmpdir(), "publish-clean-tmp-"));
    try {
      const result = runCli(
        ["--guard-only", "--no-git-checks", fx.dir],
        process.cwd(),
        { TMPDIR: temp },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).not.toContain("[dry-run]");
      const leftovers = (await readdir(temp)).filter((name) =>
        name.startsWith("publish-clean-"),
      );
      expect(leftovers).toEqual([]);
    } finally {
      await cleanup(fx.root);
      await cleanup(temp);
    }
  });

  it("keeps guard-only subject to source git cleanliness", async () => {
    const fx = await fixture(
      { name: "fixture-guard-git", version: "1.0.0", files: ["index.js"] },
      { "index.js": "module.exports = 1;\n" },
    );
    try {
      spawnSync("git", ["init"], { cwd: fx.dir, stdio: "ignore" });
      const result = runCli(["--guard-only", fx.dir], process.cwd());
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Source package has uncommitted changes");
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

  it("rejects devFields entries that would remove runtime manifest fields", async () => {
    const fx = await fixture(
      {
        name: "fixture-protected-devfield",
        version: "1.0.0",
        files: ["index.js"],
        dependencies: { bad: "link:../bad" },
        "publish-clean": { devFields: ["dependencies"] },
      },
      { "index.js": "module.exports = 1;\n" },
    );
    try {
      const result = runCli(
        ["--dry-run", "--no-git-checks", fx.dir],
        process.cwd(),
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("publish-clean.devFields");
      expect(result.stderr).toContain("dependencies");
    } finally {
      await cleanup(fx.root);
    }
  });

  it("validates non-dot-slash main, bin, and typesVersions paths", async () => {
    const fx = await fixture(
      {
        name: "fixture-declared-paths",
        version: "1.0.0",
        files: ["index.js"],
        main: "missing.js",
        bin: { fixture: "bin/missing.js" },
        typesVersions: { "*": { "*": ["missing.d.ts"] } },
      },
      { "index.js": "module.exports = 1;\n" },
    );
    try {
      const result = runCli(
        ["--dry-run", "--no-git-checks", fx.dir],
        process.cwd(),
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("missing.js");
      expect(result.stderr).toContain("bin/missing.js");
      expect(result.stderr).toContain("missing.d.ts");
    } finally {
      await cleanup(fx.root);
    }
  });

  it("rejects manifest paths that escape the packed package root", async () => {
    const fx = await fixture(
      {
        name: "fixture-path-traversal",
        version: "1.0.0",
        files: ["index.js"],
        exports: "./../fixture-path-traversal-1.0.0.tgz",
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
        "Manifest declares invalid package paths",
      );
      expect(result.stderr).toContain("../fixture-path-traversal-1.0.0.tgz");
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
      await cleanupExtracted(result.stdout);
    } finally {
      await cleanup(fx.root);
    }
  });
});
