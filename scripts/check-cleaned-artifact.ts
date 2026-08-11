import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * This package promises consumers that installing it pulls in nothing else, and that
 * promise is load-bearing: it sits on the publish path and handles registry credentials,
 * so every transitive package would be code nobody audited holding a live token.
 *
 * The assertion runs against the *cleaned* manifest rather than the source one, because
 * that is the manifest consumers resolve. A dependency added to the source and stripped
 * by the cleaner would be invisible here, and correctly so.
 */
function assertNoRuntimeDependencies(cleanedPackageDir: string): void {
  const manifest = JSON.parse(
    readFileSync(path.join(cleanedPackageDir, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const declared = ["dependencies", "peerDependencies", "optionalDependencies"]
    .filter((field) => Object.keys((manifest[field] as object | undefined) ?? {}).length > 0)
    .map((field) => `${field}: ${Object.keys(manifest[field] as object).join(", ")}`);
  if (declared.length > 0) {
    throw new Error(
      `The published package must have no runtime dependencies, but declares:\n${declared.join("\n")}`,
    );
  }
}

function run(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed\n${output}`);
  }
  return result.stdout;
}

// The CLI keeps no temp tree, so this script names its own and deletes it.
// publint reads the extracted package; @arethetypeswrong/cli reads the tarball.
const root = mkdtempSync(path.join(tmpdir(), "publish-clean-check-"));
try {
  run(process.execPath, ["dist/cli.js", "--dry-run", "--no-git-checks", "--tarball-out", root]);
  const packed = readdirSync(root).filter((entry) => entry.endsWith(".tgz"));
  const [name] = packed;
  if (packed.length !== 1 || !name)
    throw new Error(`expected exactly one tarball in ${root}, found ${packed.length}`);

  const tarball = path.join(root, name);
  run("tar", ["xzf", tarball, "-C", root]);
  const artifact = path.join(root, "package");

  assertNoRuntimeDependencies(artifact);
  run("bunx", ["publint", "run", artifact, "--pack", "false"]);
  run("bunx", ["@arethetypeswrong/cli", tarball]);
} finally {
  rmSync(root, { recursive: true, force: true });
}
