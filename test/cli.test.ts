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
import { run } from "../src/command";

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
  it("reports the version of the package it was installed from", async () => {
    const result = await runCli(["--version"], process.cwd());
    const installed = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe(installed.version);
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
      main: "./index",
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
        files: ["index.js", "index.d.ts", ".gitignore", "install.cjs"],
        scripts: { build: "tsc", postinstall: "npm run setup", setup: "node install.cjs" },
        devDependencies: { typescript: "^5.0.0" },
        // Unrecognised, and each half of the response matters: staying silent hides the
        // drift, and dropping the field would break a consumer who does read it.
        someToolConfig: { threshold: 5 },
        // Unrecognised but acknowledged. A report whose only resolution deletes the field is
        // unusable for an ecosystem this tool does not know — a VS Code extension needs
        // `contributes` in the artifact to work at all — so keepFields must silence the
        // report while leaving the field in place.
        contributes: { commands: [] },
        // `.gitignore` really is bytes no consumer reads, so the reachability rule is right to
        // refuse it — and it must ship anyway, for the reason above. This is what the escape
        // hatch is for, and declaring it here proves the hatch works end to end.
        "publish-clean": { allowUnreferenced: [".gitignore"], keepFields: ["contributes"] },
        ...consumerFacing,
        main: "./src/index",
        publishConfig: { main: consumerFacing.main },
      },
      {
        "index.js": "export const ok = true;\n",
        "index.d.ts": "export {};\n",
        ".gitignore": "index.d.ts\n",
        "install.cjs": "require('node:fs').writeFileSync('installed.txt', 'helper ran');",
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
      expect(cleaned.scripts).toEqual({
        build: "tsc",
        postinstall: "npm run setup",
        setup: "node install.cjs",
      });
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
      // --tarball-out kept, entry for entry in both directions. This is also the one case
      // that holds this tool's own tar reader — which every guard's file list comes from —
      // against the `tar` binary on a real pnpm archive. An instrument that agrees with
      // nothing outside itself is not evidence, and a reader that quietly drops or invents
      // an entry would leave every content check judging a file set nobody receives.
      const lines = result.stdout.split("\n");
      const listed = lines.slice(
        lines.findIndex((line) => /^\[dry-run] \d+ files:$/.test(line)) + 1,
        lines.findIndex((line) => line.startsWith("[dry-run] cleaned package.json")),
      );
      expect(listed.map((line) => JSON.parse(line.trim()) as string).sort()).toEqual(
        listTarball(tarball).sort(),
      );
      const consumer = path.join(fx.root, "consumer");
      await mkdir(consumer);
      await writeFile(path.join(consumer, "package.json"), '{"name":"consumer","private":true}');
      await run(
        "npm",
        [
          "install",
          tarball,
          "--offline",
          "--no-audit",
          "--no-fund",
          "--package-lock=false",
          "--ignore-scripts=false",
        ],
        consumer,
        { timeout: CLI_TIMEOUT_MS },
      );
      expect(
        await readFile(path.join(consumer, "node_modules/fixture-complete/installed.txt"), "utf8"),
      ).toBe("helper ran");
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

  it("rejects configured provenance when npm is too old for trusted publishing", async () => {
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
if [ "$*" = "config get provenance" ]; then echo "true"; exit 0; fi
echo "unexpected npm $*" >&2
exit 1
`,
      );
      const result = await runCli(["--no-git-checks", fx.dir], process.cwd(), {
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
  // and the test only ever proved that packing happened. `--allow-suspicious` is on to show
  // that it relaxes the suspicious-file check without ever relaxing the critical one.
  //
  // The abort is checked here too rather than in a run of its own: a guard that rejects a
  // package but leaves its extracted copy in the temp directory leaks the very secret it
  // just refused to publish, so the refusal and the cleanup are one behaviour.
  // The two policies shared one flag until 0.6.0, so a package that legitimately declares no
  // `files` array — a convention, not a safety property — had to pass a flag that also
  // disarmed the artifact scan. That is the shape of an opt-out that quietly removes a guard
  // nobody meant to remove, so the split is held here: relaxing the convention must leave the
  // scan armed.
  // A shipped development file used to throw, which ended the run before any other rule reported.
  // An author then fixed the one thing they were shown, re-ran, and met the next problem — and the
  // ones after that — one round trip at a time, never knowing how many were left. It is the same
  // class of waste as `unreferenced-file`, which has always reported instead, so it reports too.
  it("reports a development file alongside the rest, not instead of them", async () => {
    const fx = await fixture(
      {
        name: "fixture-suspicious-with-more",
        version: "1.0.0",
        files: ["index.js", "test", "dead.js", "deploy.key"],
        exports: { ".": "./index.js" },
      },
      {
        "index.js": "module.exports = 1;\n",
        "test/a.test.js": "// shipped by accident\n",
        "dead.js": "module.exports = 2;\n".repeat(80),
        "deploy.key": "-----BEGIN PRIVATE KEY-----\n",
      },
    );
    try {
      const result = await runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
      expect(result.status).not.toBe(0);
      // Three unrelated rules, one run. Each used to end the run at its own hit, so an author
      // learned one of these per round trip and never knew how many were left.
      expect(result.stderr).toContain("deploy.key");
      expect(result.stderr).toContain("test/a.test.js");
      expect(result.stderr).toContain("dead.js");
      // Each waiver names itself, so the reader is not left guessing how to overrule it.
      expect(result.stderr).toContain("--allow-suspicious");
      // And exactly one repair per file: the key must never appear inside a paste-ready
      // `allowUnreferenced` waiver, which would teach an author to whitelist a credential.
      expect(result.stderr).not.toMatch(/allowUnreferenced[^\n]*deploy\.key/);
    } finally {
      await cleanup(fx.root);
    }
  });

  it("keeps scanning the artifact when the files-array requirement is waived", async () => {
    const fx = await fixture(
      { name: "fixture-no-files-field", version: "1.0.0" },
      { "index.js": "module.exports = 1;\n", "index.test.js": "// shipped by accident\n" },
    );
    try {
      const result = await runCli(
        ["--dry-run", "--no-git-checks", "--skip-file-check", fx.dir],
        process.cwd(),
      );
      expect(result.status).not.toBe(0);
      // The rule id rather than its prose: an id is the stable handle a finding promises, so this
      // pins which check refused the publish without pinning a sentence anybody may rewrite.
      expect(result.stderr).toContain("suspicious-file");
      expect(result.stderr).toContain("index.test.js");
    } finally {
      await cleanup(fx.root);
    }
  });

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
        ["--dry-run", "--no-git-checks", "--allow-suspicious", fx.dir],
        process.cwd(),
        { TMPDIR: temp },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("secret-file");
      expect(result.stderr).toContain("config/deploy.key");
      // `--allow-suspicious` is set above, and must not have reached this: one escape hatch
      // relaxes exactly one policy, and nobody waiving a test-tree judgement is consenting to
      // publish a key.
      expect(result.stderr).toMatch(/rotate/i);
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

  it("checks the working tree where there is one, and says so where there is not", async () => {
    const fx = await fixture(
      { name: "fixture-guard-git", version: "1.0.0", files: ["index.js"] },
      { "index.js": "module.exports = 1;\n" },
    );
    try {
      // One `git init` apart, in the same position. A directory under no version control has no
      // commit for its tree to differ from, so this check has nothing to assert about it and must
      // not stop the run — measured, `pnpm publish` packs from such a directory without complaint,
      // and this tool packs with `pnpm pack`, whose own git check never runs. Silence would be
      // wrong too: an author who believed they were in a checkout is publishing unverified source.
      const unversioned = await runCli(["--guard-only", fx.dir], process.cwd());
      expect(unversioned.status, `${unversioned.stdout}\n${unversioned.stderr}`).toBe(0);
      expect(unversioned.stderr).toContain("skipping the uncommitted-changes check");

      spawnSync("git", ["init"], { cwd: fx.dir, stdio: "ignore" });
      const result = await runCli(["--guard-only", fx.dir], process.cwd());
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Source package has uncommitted changes");
    } finally {
      await cleanup(fx.root);
    }
  });

  it("explains a failure without burying it in this tool's own stack frames", async () => {
    const fx = await fixture({ name: "fixture-cause", version: "1.0.0" }, {});
    try {
      await writeFile(path.join(fx.dir, "package.json"), '{"name":"x", oops}');
      const result = await runCli(["verify", fx.dir], process.cwd());
      expect(result.status).not.toBe(0);
      // Both halves, because either alone passes for the wrong implementation: dropping the cause
      // loses the only thing that says WHERE the syntax broke, and printing the cause object drags
      // in frames from this file that push the actionable line out of a CI log and send an agent
      // reading it into node internals instead of the fix. The cause's own wording is Node's and
      // changes between releases, so the assertion is on shape rather than on its text.
      expect(result.stderr).toContain("Caused by:");
      expect(result.stderr).not.toMatch(/^\s+at /m);
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

it.concurrent("scans and preserves the effective names pnpm emits for long USTAR and PAX paths", async () => {
  const prefix = `dist/${("d".repeat(70) + "/").repeat(4)}`;
  const names = [`dist/${"d".repeat(70)}/safe.js`, `${prefix}safe.js`];
  const fx = await fixture(
    { name: "long-paths", version: "1.0.0", files: ["dist"] },
    Object.fromEntries(names.map((name) => [name, "fixture"])),
  );
  try {
    const out = path.join(fx.root, "out");
    const good = await runCli(
      ["--dry-run", "--no-git-checks", "--tarball-out", out, fx.dir],
      process.cwd(),
    );
    expect(good.status, good.stderr).toBe(0);
    const tarball = await soleTarball(out);
    expect(listTarball(tarball).sort()).toEqual([...names, "package.json"].sort());
    for (const name of names) {
      expect(good.stdout).toContain(name);
      expect(readTarballFile(tarball, name)).toBe("fixture");
    }
    const secret = `${prefix}secret.pem`;
    await writeFile(path.join(fx.dir, secret), "fixture");
    const result = await runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(secret);
    expect(result.stderr).toContain("secret-file");
  } finally {
    await cleanup(fx.root);
  }
});

it.concurrent("rejects a private flag written by prepack before it can be stripped", async () => {
  const fx = await fixture(
    {
      name: "becomes-private",
      version: "1.0.0",
      files: ["index.js"],
      scripts: { prepack: "node mark-private.cjs" },
    },
    {
      "index.js": "module.exports = 1",
      "mark-private.cjs": `const fs = require('node:fs'); const pkg = JSON.parse(fs.readFileSync('package.json')); pkg.private = true; fs.writeFileSync('package.json', JSON.stringify(pkg));`,
    },
  );
  try {
    const result = await runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("private: true");
  } finally {
    await cleanup(fx.root);
  }
});

it.concurrent("streams verbose lifecycle output without a capture-buffer failure", async () => {
  const fx = await fixture(
    {
      name: "verbose-pack",
      version: "1.0.0",
      files: ["index.js"],
      scripts: { prepack: "node verbose.cjs" },
    },
    {
      "index.js": "module.exports = 1",
      "verbose.cjs": `process.stdout.write('x'.repeat(2 * 1024 * 1024));`,
    },
  );
  try {
    const result = await runCli(["--dry-run", "--no-git-checks", fx.dir], process.cwd());
    expect(result.status, result.stderr.slice(-2000)).toBe(0);
    expect(result.stderr.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(result.stdout).toContain("cleaned package.json");
  } finally {
    await cleanup(fx.root);
  }
});

it.skipIf(process.platform === "win32").concurrent(
  "cancels a live lifecycle and removes its temporary archive directory",
  async () => {
    const fx = await fixture(
      {
        name: "cancel-pack",
        version: "1.0.0",
        files: ["index.js"],
        scripts: { prepack: "node waiting.cjs" },
      },
      {
        "index.js": "module.exports = 1",
        "waiting.cjs": `process.on('SIGTERM', () => console.log('PACK_STOPPING')); console.log('PACK_READY:' + process.pid); setInterval(() => {}, 1000);`,
      },
    );
    const temp = path.join(fx.root, "temp");
    await mkdir(temp);
    let lifecyclePid: number | undefined;
    let repeatedSignal = false;
    const child = spawn("node", [CLI, "--dry-run", "--no-git-checks", fx.dir], {
      env: { ...process.env, TMPDIR: temp },
      // The file's own bound, not a tighter one. This child is killed BY the test the moment it
      // reports readiness, so the timeout exists only to bound a hang — and when it fires early it
      // SIGKILLs, turning the exit code into 137 and failing the assertion below as "expected 137
      // to be 143", which reads as a cancellation defect rather than as a slow machine. At 5s it
      // had 1.6x headroom over this case's measured 3.1s, which a slower runner does not have.
      timeout: CLI_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    try {
      const result = await new Promise<{ status: number | null; stderr: string }>(
        (resolve, reject) => {
          let stderr = "";
          child.stdout.resume();
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
            const match = /PACK_READY:(\d+)/.exec(stderr);
            if (match && lifecyclePid === undefined) {
              lifecyclePid = Number(match[1]);
              child.kill("SIGTERM");
            }
            if (stderr.includes("PACK_STOPPING") && !repeatedSignal) {
              repeatedSignal = true;
              child.kill("SIGTERM");
            }
          });
          child.on("error", reject);
          child.on("close", (status) => resolve({ status, stderr }));
        },
      );
      expect(lifecyclePid, result.stderr).toBeDefined();
      expect(repeatedSignal, result.stderr).toBe(true);
      expect(result.status, result.stderr).toBe(143);
      expect((await readdir(temp)).filter((name) => name.startsWith("publish-clean-"))).toEqual([]);
      expect(() => process.kill(lifecyclePid ?? 0, 0)).toThrow();
    } finally {
      child.kill("SIGKILL");
      if (lifecyclePid !== undefined) {
        try {
          process.kill(lifecyclePid, "SIGKILL");
        } catch {}
      }
      await cleanup(fx.root);
    }
  },
);

it.concurrent("probes the npm version in the package directory, once", async () => {
  const fx = await fixture(
    { name: "cwd-version", version: "1.0.0", files: ["index.js"] },
    { "index.js": "x" },
  );
  const bin = path.join(fx.root, "bin");
  const log = path.join(fx.root, "probe.log");
  try {
    await mkdir(bin);
    await writeShim(
      path.join(bin, "npm"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  pwd -P >> '${log}'
  if [ "$(pwd -P)" = '${await realpath(fx.dir)}' ]; then echo 10.0.0; else echo 11.19.0; fi
  exit 0
fi
exit 97
`,
    );
    const result = await runCli(["--no-git-checks", fx.dir, "--", "--provenance"], process.cwd(), {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires npm 11.5.1");
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([await realpath(fx.dir)]);
  } finally {
    await cleanup(fx.root);
  }
});

it.concurrent.each(["--dry-run", "--guard-only"])(
  "runs the final artifact validator in %s",
  async (mode) => {
    const fx = await fixture(
      {
        name: "validator-preview",
        version: "1.0.0",
        files: ["index.js"],
        "publish-clean": { validateArtifact: [process.execPath, "validate.cjs"] },
      },
      {
        "index.js": "module.exports = 1;",
        "validate.cjs": "require('node:fs').writeFileSync('checked', process.argv.at(-1));",
      },
    );
    try {
      const result = await runCli([mode, "--no-git-checks"], fx.dir);
      expect(result.status, result.stderr).toBe(0);
      const artifact = await readFile(path.join(fx.dir, "checked"), "utf8");
      expect(path.isAbsolute(artifact)).toBe(true);
      await expect(readFile(artifact)).rejects.toThrow();
    } finally {
      await cleanup(fx.root);
    }
  },
);
