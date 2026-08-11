import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
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

/**
 * Runs the built CLI without blocking the worker thread.
 *
 * Async on purpose, and it is not a style choice. `spawnSync` holds the thread for the
 * whole run, so vitest's own `testTimeout` can never fire — its timer gets no turn — and
 * every case here serialises behind the last even though each one is an independent
 * process against its own temp directory. Yielding restores both: the real timeout
 * applies, and the suite is free to run these concurrently.
 *
 * The spawn keeps its own bound as well, because a timeout is the only thing that ends a
 * wedged child: failing the test would otherwise leave the process alive. It must stay under
 * vitest's `testTimeout`, or vitest fails the case first and the child outlives the run.
 */
const CLI_TIMEOUT_MS = 30_000;

function runCli(
  args: readonly string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ status: null | number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
      timeout: CLI_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr, stdout }));
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

async function soleTarball(dir: string): Promise<string> {
  const packed = (await readdir(dir)).filter((entry) => entry.endsWith(".tgz"));
  const [name] = packed;
  if (packed.length !== 1 || !name)
    throw new Error(`expected one tarball in ${dir}, found ${packed.length}`);
  return path.join(dir, name);
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

function listTarball(tarball: string): string[] {
  const result = spawnSync("tar", ["tzf", tarball], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 0 && !line.endsWith("/"))
    .map((line) => line.replace(/^package\//, ""));
}

// Concurrent because each case is an independent process against its own temp directory,
// sharing nothing: the only reason they ever ran one at a time was the blocking spawn.
// The work is real packing, so the ceiling is cores, not this setting.
describe.concurrent("publish-clean", () => {
  it("prints all supported options in help", async () => {
    const result = await runCli(["--help"], process.cwd());
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("--no-git-checks");
    expect(result.stdout).toContain("npm-publish-args");
  });

  it("rejects unknown CLI options before publish args", async () => {
    const result = await runCli(["--dryrun"], process.cwd());
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
      const result = await runCli(["--dry-run", "--no-git-checks", fx.dir, "stray"], process.cwd());
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Unexpected positional arguments");
    } finally {
      await cleanup(fx.root);
    }
  });

  // One package carrying every happy-path concern at once, asserted from a single run.
  // The cost here is two real package managers and a tarball, and that cost buys one thing:
  // what pnpm and npm actually do to a manifest this tool cleaned. That answer does not vary
  // with the field under inspection, so a run per field bought nothing but wall-clock. Each
  // rule's own matrix is exercised directly in the rules suite.
  //
  // Run from inside the package with publish args after `--` and no positional, because that
  // is the shape the release workflow uses: it also proves those args are not mistaken for
  // the package directory, and that the directory defaults to the working one.
  it("publishes a correct artifact from a package declaring every kind of field", async () => {
    // Fields a consumer or the registry resolves. Cleaning is subtraction, so it fails by
    // taking too much, and a field that quietly vanished leaves no trace in the artifact.
    // `repository` is the sharpest case: losing it breaks provenance verification while the
    // package still installs fine. Condition order inside `exports` must survive
    // byte-identical as well — a reordered or partly dropped map still installs and still
    // imports, just from the wrong file, on one runtime only.
    const consumerFacing = {
      description: "fixture",
      repository: { type: "git", url: "git+https://example.test/x.git" },
      funding: "https://example.test/fund",
      engines: { node: ">=20" },
      sideEffects: false,
      exports: { ".": { types: "./index.d.ts", bun: "./index.js", import: "./index.js" } },
    };
    const fx = await fixture(
      {
        name: "fixture-complete",
        version: "1.0.0",
        type: "module",
        // `.gitignore` is shipped AND excludes a shipped file. Nothing may re-derive the file
        // set after pnpm selected it, and this is the shape that proves it: a pipeline that
        // packed a second time would find no `files` in the cleaned manifest, fall back to
        // this `.gitignore`, and drop `index.d.ts` from the published tarball.
        files: ["index.js", "index.d.ts", ".gitignore"],
        scripts: { build: "tsc", postinstall: "node index.js" },
        devDependencies: { typescript: "^5.0.0" },
        // Unrecognised, and each half of the response matters: staying silent hides the
        // drift, and dropping the field would break a consumer who does read it.
        someToolConfig: { threshold: 5 },
        // Unrecognised but acknowledged. A report whose only resolution deletes the field is
        // unusable for an ecosystem this tool does not know — a VS Code extension needs
        // `contributes` in the artifact to work at all — so keepFields must silence the
        // report while leaving the field in place.
        contributes: { commands: [] },
        "publish-clean": { keepFields: ["contributes"] },
        ...consumerFacing,
      },
      {
        "index.js": "export const ok = true;\n",
        "index.d.ts": "export {};\n",
        ".gitignore": "index.d.ts\n",
      },
    );
    const out = path.join(fx.root, "artifacts");
    try {
      const result = await runCli(
        ["--dry-run", "--no-git-checks", "--tarball-out", out, "--", "--tag", "next"],
        fx.dir,
        // Not pnpm, so the lifecycle warning fires: this tool packs with pnpm and silently
        // getting another packer's file selection is the failure it warns about.
        { npm_config_user_agent: "npm/11.0.0 node/v24" },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain("packs with pnpm");
      expect(result.stderr).toContain("npm/11.0.0");

      const tarball = await soleTarball(out);
      const cleaned = JSON.parse(readTarballFile(tarball, "package.json")) as Record<
        string,
        unknown
      >;
      expect(cleaned.devDependencies).toBeUndefined();
      expect(cleaned["publish-clean"]).toBeUndefined();
      expect(cleaned.scripts).toEqual({ postinstall: "node index.js" });
      expect(cleaned.someToolConfig).toEqual({ threshold: 5 });
      expect(cleaned.contributes).toEqual({ commands: [] });

      expect(result.stderr).toContain("someToolConfig");
      expect(result.stderr).toContain(`"devFields": ["someToolConfig"]`);
      expect(result.stderr).not.toContain("contributes");

      // Stripped, and the entry below proves that costs nothing: the file this package's own
      // `.gitignore` excludes still ships, because the tarball was rewritten rather than
      // repacked and no packer consults `files` again.
      expect(cleaned.files).toBeUndefined();
      expect(readTarballFile(tarball, "index.d.ts")).toBe("export {};\n");
      for (const [field, value] of Object.entries(consumerFacing))
        expect(cleaned[field]).toEqual(value);

      // The report is the only output of a dry-run, so it has to describe the bytes that
      // --tarball-out kept. A report listing files the retained tarball lacks is a lie.
      for (const file of listTarball(tarball)) expect(result.stdout).toContain(file);
    } finally {
      await cleanup(fx.root);
    }
  });

  // Both halves attack the same assumption — that packer stdout is a clean, parseable
  // report — so one package under both conditions asks the question once. `pack` runs the
  // package's `prepare`/`prepack` scripts and forwards their output, and build tools log
  // there as a matter of course; `NPM_CONFIG_JSON` restructures npm's own output from a
  // config file the CLI never sees. This is why the tarball is located on disk rather than
  // parsed out of stdout: a package with a logging build step was once unpublishable.
  it("finds the packed tarball through build chatter and reconfigured packer output", async () => {
    const fx = await fixture(
      {
        name: "fixture-noisy-pack",
        version: "1.0.0",
        files: ["index.js"],
        scripts: { prepare: "node -e \"console.log('building the package')\"" },
      },
      { "index.js": "module.exports = 1;\n" },
    );
    try {
      const result = await runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd(), {
        NPM_CONFIG_JSON: "true",
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      // Build chatter on stdout and a JSON-mode packer. Reporting the fixture's own file
      // proves the right tarball was still found and read.
      expect(result.stdout).toContain("index.js");
    } finally {
      await cleanup(fx.root);
    }
  });

  // npm is the only command this tool hands the artifact to, so the whole invocation is
  // captured: the arguments, and the directory it runs in. The directory is not incidental.
  // npm resolves a project `.npmrc` from the nearest ancestor of its working directory that
  // holds a `package.json`, so publishing from the temp tree would silently discard the
  // registry and credentials the author configured for this project — a package aimed at an
  // internal registry would go to npmjs.com instead, and nothing would say so.
  it("publishes the tarball from the source package directory", async () => {
    const fx = await fixture(
      { name: "fixture-npm-publish", version: "1.0.0", files: ["index.js"] },
      { "index.js": "module.exports = 1;\n" },
    );
    const bin = path.join(fx.root, "bin");
    const log = path.join(fx.root, "commands.log");
    try {
      await mkdir(bin);
      // Never execs the real npm: `which npm` usually resolves to a version manager's shim,
      // which re-resolves the tool BY NAME, finds this fake first and execs it again — an
      // unbounded fork/exec loop that presents as a hang.
      await writeShim(
        path.join(bin, "npm"),
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "11.5.1"; exit 0; fi
if [ "$1" = "publish" ]; then
  printf '%s\\n%s\\n' "$*" "$(pwd -P)" > "${log}"
  exit 0
fi
echo "unexpected npm $*" >&2
exit 1
`,
      );
      const result = await runCli(
        ["--no-git-checks", fx.dir, "--", "--access", "public", "--tag", "latest"],
        process.cwd(),
        { PATH: `${bin}:${process.env.PATH ?? ""}` },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const [invocation, cwd] = (await readFile(log, "utf8")).trim().split("\n");
      expect(invocation).toContain("publish ");
      expect(invocation).toContain(".tgz");
      expect(invocation).toContain("--tag latest");
      expect(cwd).toBe(await realpath(fx.dir));
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
      const result = await runCli(["--no-git-checks", fx.dir], process.cwd(), {
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
      const result = await runCli(["--no-git-checks", fx.dir], process.cwd(), {
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
      const result = await runCli(
        ["--no-git-checks", fx.dir, "--", "--provenance"],
        process.cwd(),
        {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
      );
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
    try {
      await mkdir(bin);
      await writeShim(
        path.join(bin, "npm"),
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "11.5.1"; exit 0; fi
if [ "$1" = "publish" ]; then exit 0; fi
echo "unexpected npm $*" >&2
exit 1
`,
      );
      const result = await runCli(
        ["--no-git-checks", fx.dir, "--", "--provenance"],
        process.cwd(),
        {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
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
      const result = await runCli(["--dry-run", "--no-git-checks", dir], process.cwd());
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
      const result = await runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("ERR_PNPM_INVALID_PACKAGE_NAME");
    } finally {
      await cleanup(fx.root);
    }
  });

  // The pattern matrix lives in the rules suite, where a filename costs nothing to judge.
  // What only a real packer can answer is whether the file reaches the guard at all, and a
  // nested path is the case that decides it: an earlier version of this test used a nested
  // `.npmrc`, which npm and pnpm strip from tarballs at any depth, so the guard never saw it
  // and the test only ever proved that packing happened. `--skip-file-check` is on to show
  // that it relaxes the suspicious-file check without ever relaxing the critical one.
  //
  // The abort is checked here too rather than in a run of its own: a guard that rejects a
  // package but leaves its extracted copy in the temp directory leaks the very secret it
  // just refused to publish, so the refusal and the cleanup are one behaviour.
  it("refuses a leaked key nested in the package, and leaves nothing behind", async () => {
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
    const temp = await mkdtemp(path.join(tmpdir(), "publish-clean-tmp-"));
    try {
      const result = await runCli(
        ["--dry-run", "--no-git-checks", "--skip-file-check", fx.dir],
        process.cwd(),
        { TMPDIR: temp },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Critical files must not be published");
      expect(result.stderr).toContain("config/deploy.key");
      expect(result.stdout).not.toContain("Final tarball");
      const leftovers = (await readdir(temp)).filter((name) => name.startsWith("publish-clean-"));
      expect(leftovers).toEqual([]);
    } finally {
      await cleanup(fx.root);
      await cleanup(temp);
    }
  });

  // Both modes leave the pack block through an early return; a failed guard leaves through a
  // throw, covered by the leaked-key test above. One `finally` deletes the tree for all three.
  // --dry-run used to keep its tree so the caller could look inside it, and nobody ever deleted
  // one, so the invariant is asserted per exit rather than per line.
  it.each(["--dry-run", "--guard-only"])("leaves no temporary tree after %s", async (flag) => {
    const fx = await fixture(
      { name: "fixture-cleanup", version: "1.0.0", files: ["index.js"] },
      { "index.js": "module.exports = 1;\n" },
    );
    const temp = await mkdtemp(path.join(tmpdir(), "publish-clean-tmp-"));
    try {
      const result = await runCli([flag, "--no-git-checks", fx.dir], process.cwd(), {
        TMPDIR: temp,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
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
      const result = await runCli(["--guard-only", fx.dir], process.cwd());
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Source package has uncommitted changes");
    } finally {
      await cleanup(fx.root);
    }
  });

  // End-to-end because the claim is about pnpm, not about the rule: pnpm rewrites some
  // workspace specs while packing and leaves `link:` verbatim, and only a real pack says
  // which. Published with one, the package is uninstallable for everyone and the version
  // cannot be taken back.
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
      const result = await runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unresolved monorepo-only dependency specs");
      expect(result.stderr).toContain("packs with pnpm");
    } finally {
      await cleanup(fx.root);
    }
  });
});
