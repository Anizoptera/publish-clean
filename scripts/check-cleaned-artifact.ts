import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

const artifact = match[1].trim();
const root = path.dirname(artifact);
const packRoot = mkdtempSync(path.join(tmpdir(), "publish-clean-final-pack-"));
try {
  run("bunx", ["publint", "run", artifact, "--pack", "false"]);
  run("pnpm", ["pack", "--pack-destination", packRoot, "--dir", artifact]);
  const tarball = readdirSync(packRoot).find((file) => file.endsWith(".tgz"));
  if (!tarball) throw new Error("pnpm pack did not create a tarball.");
  run("bunx", ["@arethetypeswrong/cli", path.join(packRoot, tarball)]);
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(packRoot, { recursive: true, force: true });
}
