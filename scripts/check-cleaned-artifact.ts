import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

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

const stdout = run(process.execPath, [
  "dist/cli.js",
  "--dry-run",
  "--no-git-checks",
]);
const match = /^\[dry-run\] Extracted package at: (.+)$/m.exec(stdout);
if (!match?.[1])
  throw new Error(`publish-clean did not report the cleaned artifact path.`);
const tarballMatch = /^\[dry-run\] Final tarball at: (.+)$/m.exec(stdout);
if (!tarballMatch?.[1])
  throw new Error(`publish-clean did not report the final npm tarball path.`);

const artifact = match[1].trim();
const root = path.dirname(artifact);
const tarball = tarballMatch[1].trim();
try {
  run("bunx", ["publint", "run", artifact, "--pack", "false"]);
  run("bunx", ["@arethetypeswrong/cli", tarball]);
} finally {
  rmSync(root, { recursive: true, force: true });
}
