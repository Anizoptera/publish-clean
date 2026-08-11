import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CLI = path.resolve("dist/cli.js");

interface Fixture {
  dir: string;
  root: string;
}

/**
 * Every invocation is bounded, because `spawnSync` blocks the worker thread and vitest's
 * own `testTimeout` cannot interrupt it: the timer never gets a turn to fire. Without a
 * bound here, one wedged subprocess hangs the whole suite until the CI job's multi-hour
 * ceiling, and locally until someone notices.
 *
 * The cap is deliberately far above the real cost — CI runs all of these in about a
 * minute — so it can only ever catch a genuine wedge, never a cold pnpm store.
 */
const CLI_TIMEOUT_MS = 60_000;

function runCli(
  args: readonly string[],
  cwd: string,
  env?: Record<string, string>,
): SpawnSyncReturns<string> {
  return spawnSync("node", [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: CLI_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
}

async function fixture(
  pkg: Record<string, unknown>,
  files: Record<string, string>,
): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "publish-clean-test-"));
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
      const result = runCli(["--dry-run", "--no-git-checks", fx.dir, "stray"], process.cwd());
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
      const result = runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const pkg = JSON.parse(
        await readFile(path.join(extractedPath(result.stdout), "package.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(pkg.devDependencies).toBeUndefined();
      // `files` selected these very bytes and cannot select again: the artifact it
      // describes is already packed, and an install extracts all of it unfiltered.
      expect(pkg.files).toBeUndefined();
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
      const result = runCli(["--dry-run", "--no-git-checks", "--", "--tag", "next"], fx.dir);
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
      const result = runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
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
      const result = runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
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

  // A release pipeline must attach and attest the exact bytes that reach the registry,
  // so the retained copy has to be byte-identical to the tarball the CLI publishes —
  // not a re-pack, which would differ and make any attestation a lie.
  it("keeps a byte-identical copy of the published tarball", async () => {
    const fx = await fixture(
      { name: "fixture-tarball-out", version: "1.0.0", files: ["index.js"] },
      { "index.js": "module.exports = 1;\n" },
    );
    const out = path.join(fx.root, "artifacts");
    try {
      const result = runCli(
        ["--dry-run", "--no-git-checks", "--tarball-out", out, fx.dir],
        process.cwd(),
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const kept = path.join(out, path.basename(finalTarballPath(result.stdout)));
      expect(await readFile(kept)).toEqual(await readFile(finalTarballPath(result.stdout)));
      await cleanupExtracted(result.stdout);
    } finally {
      await cleanup(fx.root);
    }
  });

  // `pack` runs the package's `prepare`/`prepack` scripts and forwards their stdout.
  // Build tools log there as a matter of course, so a foreign package's own build
  // chatter must never be mistaken for packer output.
  it("packs a package whose prepare script writes to stdout", async () => {
    const fx = await fixture(
      {
        name: "fixture-noisy-prepare",
        version: "1.0.0",
        files: ["index.js"],
        scripts: { prepare: "node -e \"console.log('building the package')\"" },
      },
      { "index.js": "module.exports = 1;\n" },
    );
    try {
      const result = runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(finalTarballPath(result.stdout)).toMatch(/\.tgz$/);
      await cleanupExtracted(result.stdout);
    } finally {
      await cleanup(fx.root);
    }
  });

  it("finds the packed tarball even when npm config requests JSON output", async () => {
    const fx = await fixture(
      { name: "fixture-json-pack", version: "1.0.0", files: ["index.js"] },
      { "index.js": "module.exports = 1;\n" },
    );
    try {
      const result = runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd(), {
        NPM_CONFIG_JSON: "true",
      });
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
  PATH="$REAL_PATH" exec "$REAL_NPM" pack "$@"
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
        ["--no-git-checks", fx.dir, "--", "--access", "public", "--tag", "latest"],
        process.cwd(),
        // REAL_PATH is this PATH without `bin`. `which npm` usually resolves to a version
        // manager's shim (asdf, mise, volta), and a shim does not run the tool: it
        // re-resolves it BY NAME. Handed a PATH whose first entry is this fake, it finds
        // the fake, which execs the shim again — an unbounded fork/exec loop that presents
        // as a hang and gets misread as slowness.
        {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          REAL_NPM: realNpm,
          REAL_PATH: process.env.PATH ?? "",
        },
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

  it("reports a required tool's own words when it is present but refuses to run", async () => {
    const fx = await fixture(
      { name: "fixture-broken-shim", version: "1.0.0", files: ["index.js"] },
      { "index.js": "module.exports = 1;\n" },
    );
    const bin = path.join(fx.root, "bin");
    try {
      await mkdir(bin);
      // A version-manager shim (asdf, mise, volta, corepack) resolves in PATH but exits
      // non-zero when no version is pinned. Diagnosing that as "not in PATH" sends the
      // reader to verify the one thing that is already fine, and `which pnpm` will agree
      // with them and not with the tool.
      await writeShim(
        path.join(bin, "pnpm"),
        `#!/bin/sh
echo "No version is set for command pnpm" >&2
exit 126
`,
      );
      const result = runCli(["--no-git-checks", fx.dir], process.cwd(), {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain("not available in PATH");
      expect(result.stderr).toContain("No version is set for command pnpm");
    } finally {
      await cleanup(fx.root);
    }
  });

  it("still reports a genuinely absent tool as missing", async () => {
    const fx = await fixture(
      { name: "fixture-absent-tool", version: "1.0.0", files: ["index.js"] },
      { "index.js": "module.exports = 1;\n" },
    );
    try {
      // Node's own directory keeps the CLI runnable while leaving every package manager
      // out of reach, which is the only way to exercise a genuine ENOENT.
      const result = runCli(["--no-git-checks", fx.dir], process.cwd(), {
        PATH: path.dirname(process.execPath),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("pnpm");
      expect(result.stderr).toContain("not available in PATH");
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
      const result = runCli(["--no-git-checks", fx.dir, "--", "--provenance"], process.cwd(), {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      });
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
if [ "$1" = "pack" ]; then shift; PATH="$REAL_PATH" exec "$REAL_NPM" pack "$@"; fi
if [ "$1" = "publish" ]; then exit 0; fi
echo "unexpected npm $*" >&2
exit 1
`,
      );
      const result = runCli(["--no-git-checks", fx.dir, "--", "--provenance"], process.cwd(), {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        REAL_NPM: realNpm,
        REAL_PATH: process.env.PATH ?? "", // see the shim note above: no path back to the fake
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "Anizoptera/publish-clean",
      });
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
      const result = runCli(["--dry-run", "--no-git-checks", dir], process.cwd());
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
      const result = runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
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

  // Nested paths are the interesting case: a critical file is easy to spot at the
  // package root and easy to miss one directory down. The leaked secret here is a
  // private key rather than a nested `.npmrc`, because npm and pnpm strip `.npmrc`
  // from tarballs at any depth — a fixture the packer refuses to emit can never
  // reach this guard and only ever proves that packing happened.
  it("refuses critical leaked files in nested package paths", async () => {
    const fx = await fixture(
      {
        name: "fixture-nested-leak",
        version: "1.0.0",
        files: ["index.js", "config/deploy.key"],
      },
      {
        "index.js": "module.exports = 1;\n",
        "config/deploy.key": "-----BEGIN PRIVATE KEY-----\n",
      },
    );
    try {
      const result = runCli(
        ["--dry-run", "--no-git-checks", "--skip-file-check", fx.dir],
        process.cwd(),
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("config/deploy.key");
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
      const leftovers = (await readdir(temp)).filter((name) => name.startsWith("publish-clean-"));
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
      const result = runCli(["--guard-only", "--no-git-checks", fx.dir], process.cwd(), {
        TMPDIR: temp,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).not.toContain("[dry-run]");
      const leftovers = (await readdir(temp)).filter((name) => name.startsWith("publish-clean-"));
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
      const result = runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unresolved monorepo-only dependency specs");
      expect(result.stderr).toContain("packs with pnpm");
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
      const result = runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
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
      const result = runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
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
      const result = runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Manifest declares invalid package paths");
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
      const result = runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd(), {
        npm_config_user_agent: "npm/11.0.0 node/v24",
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain("packs with pnpm");
      expect(result.stderr).toContain("npm/11.0.0");
      await cleanupExtracted(result.stdout);
    } finally {
      await cleanup(fx.root);
    }
  });

  // The report exists because the strip list cannot know about tools invented after it was
  // written. Both halves matter and can fail independently: staying silent hides the drift,
  // and dropping the field would break a consumer who does read it. A recognised field
  // appearing in the report would be just as bad, because a report nobody trusts is noise.
  it("reports an unrecognised manifest field and still publishes it", async () => {
    const fx = await fixture(
      {
        name: "fixture-unknown-field",
        version: "1.0.0",
        files: ["index.js"],
        funding: "https://example.test/fund",
        someToolConfig: { threshold: 5 },
      },
      { "index.js": "module.exports = 1;\n" },
    );
    try {
      const result = runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain("someToolConfig");
      expect(result.stderr).toContain(`"devFields": ["someToolConfig"]`);
      expect(result.stderr).not.toContain("funding");

      const extracted = /^\[dry-run\] Extracted package at: (.+)$/m.exec(result.stdout)?.[1];
      const shipped = JSON.parse(
        await readFile(path.join(String(extracted).trim(), "package.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(shipped.someToolConfig).toEqual({ threshold: 5 });
      expect(shipped.funding).toBe("https://example.test/fund");

      await cleanupExtracted(result.stdout);
    } finally {
      await cleanup(fx.root);
    }
  });

  // The package's headline promise is that a private key cannot reach the registry, so the
  // ways a key file evades a pattern are the failures that matter most. Both cases here
  // shipped silently before: an SSH key carries no extension, and on the case-insensitive
  // filesystems most packages are built on, `Server.PEM` is the same file as `server.pem`.
  it.each(["id_rsa", "deploy/id_ed25519", "Server.PEM", "certs/private.Key"])(
    "refuses to publish %s",
    async (secret) => {
      const fx = await fixture(
        { name: "fixture-key-leak", version: "1.0.0", files: ["index.js", secret.split("/")[0]] },
        { "index.js": "module.exports = 1;\n", [secret]: "PRIVATE KEY\n" },
      );
      try {
        const result = runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
        expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
        expect(result.stderr).toContain("Critical files must not be published");
        expect(result.stderr).toContain(secret);
      } finally {
        await cleanup(fx.root);
      }
    },
  );

  // Cleaning is subtraction, so it fails by taking too much, and a field that quietly
  // vanished leaves no trace in the artifact. `repository` is the sharpest case: losing it
  // breaks provenance verification while the package still installs fine.
  it("publishes every consumer-facing field the source declared", async () => {
    const declared = {
      description: "fixture",
      repository: { type: "git", url: "git+https://example.test/x.git" },
      funding: "https://example.test/fund",
      engines: { node: ">=20" },
      sideEffects: false,
      // Condition order decides which build each consumer gets, so this must survive
      // byte-identical: a reordered or partially dropped map still installs and still
      // imports, just from the wrong file, on one runtime only.
      exports: { ".": { types: "./index.d.ts", bun: "./index.js", import: "./index.js" } },
    };
    const fx = await fixture(
      {
        name: "fixture-kept-fields",
        version: "1.0.0",
        files: ["index.js", "index.d.ts"],
        ...declared,
      },
      { "index.js": "module.exports = 1;\n", "index.d.ts": "export {};\n" },
    );
    try {
      const result = runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const tarball = /^\[dry-run\] Final tarball at: (.+)$/m.exec(result.stdout)?.[1];
      const shipped = JSON.parse(
        spawnSync("tar", ["xzOf", String(tarball).trim(), "package/package.json"], {
          encoding: "utf8",
        }).stdout,
      ) as Record<string, unknown>;
      for (const [field, value] of Object.entries(declared)) expect(shipped[field]).toEqual(value);
      await cleanupExtracted(result.stdout);
    } finally {
      await cleanup(fx.root);
    }
  });

  // A report whose only resolution deletes the field is unusable for any package whose
  // ecosystem this tool does not know: a VS Code extension needs `contributes` in the
  // artifact to work at all. keepFields must silence the report while leaving the field in
  // place, or the author's only options are a permanent warning or a broken package.
  it("stops reporting a field acknowledged through keepFields, and still ships it", async () => {
    const fx = await fixture(
      {
        name: "fixture-keep-field",
        version: "1.0.0",
        files: ["index.js"],
        contributes: { commands: [] },
        "publish-clean": { keepFields: ["contributes"] },
      },
      { "index.js": "module.exports = 1;\n" },
    );
    try {
      const result = runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).not.toContain("contributes");

      const extracted = /^\[dry-run\] Extracted package at: (.+)$/m.exec(result.stdout)?.[1];
      const shipped = JSON.parse(
        await readFile(path.join(String(extracted).trim(), "package.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(shipped.contributes).toEqual({ commands: [] });

      await cleanupExtracted(result.stdout);
    } finally {
      await cleanup(fx.root);
    }
  });
});
