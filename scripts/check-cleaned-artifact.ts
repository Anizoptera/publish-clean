import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
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

const stdout = run(process.execPath, ["dist/cli.js", "--dry-run", "--no-git-checks"]);
const match = /^\[dry-run\] Extracted package at: (.+)$/m.exec(stdout);
if (!match?.[1]) throw new Error(`publish-clean did not report the cleaned artifact path.`);
const tarballMatch = /^\[dry-run\] Final tarball at: (.+)$/m.exec(stdout);
if (!tarballMatch?.[1]) throw new Error(`publish-clean did not report the final npm tarball path.`);

const artifact = match[1].trim();
const root = path.dirname(artifact);
const tarball = tarballMatch[1].trim();
try {
  assertNoRuntimeDependencies(artifact);
  run("bunx", ["publint", "run", artifact, "--pack", "false"]);
  run("bunx", ["@arethetypeswrong/cli", tarball]);
} finally {
  rmSync(root, { recursive: true, force: true });
}
