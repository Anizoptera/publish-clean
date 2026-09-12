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

/**
 * The one file consumers install must declare its licence, and must have come from this tree.
 *
 * `SPDX-License-Identifier` is the entire mechanism for declaring a licence to a scanner that reads
 * this file and nothing around it, and it is a COMMENT — so it is precisely what a minifier drops,
 * while every other check here stays green. Nothing downstream raises it either: a scanner finding
 * no tag reports the file as unlicensed rather than failing.
 *
 * The version is checked because the banner is generated from the manifest at BUILD time while the
 * manifest read here is the PACKED one. The two can disagree only when the packed `dist` was built
 * from a different tree than the manifest beside it — the stale-artifact case every other check in
 * this pipeline assumes away, because each of them reads whatever `dist/cli.js` happens to hold.
 *
 * No shebang assertion: publint below reports `BIN_FILE_NOT_EXECUTABLE` for a bin entry that lacks
 * one, and it runs at error level. A second copy here would be weaker evidence of the same fact.
 */
function assertBannerDeclaresTheArtifact(cleanedPackageDir: string): void {
  const { license, name, version } = JSON.parse(
    readFileSync(path.join(cleanedPackageDir, "package.json"), "utf8"),
  ) as { license: string; name: string; version: string };
  const [, spdx = "", identity = ""] = readFileSync(
    path.join(cleanedPackageDir, "dist", "cli.js"),
    "utf8",
  ).split("\n", 3);

  const tag = `// SPDX-License-Identifier: ${license}`;
  if (spdx !== tag)
    throw new Error(
      `dist/cli.js must carry its licence tag on the line under the shebang.\n  expected: ${tag}\n  found:    ${spdx}\n` +
        `It is emitted by the banner in tsdown.config.ts; a minifier or bundler that strips leading comments removes it.`,
    );

  if (!identity.startsWith(`// ${name} ${version} `))
    throw new Error(
      `dist/cli.js names a version the manifest beside it does not.\n  manifest: ${version}\n  banner:   ${identity}\n` +
        `The packed dist/ was built from a different tree than its manifest, so the artifact is stale: rebuild, then pack.`,
    );
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
  assertBannerDeclaresTheArtifact(artifact);
  run("bunx", ["publint", "run", artifact, "--pack", "false"]);
  run("bunx", ["@arethetypeswrong/cli", tarball]);
} finally {
  rmSync(root, { recursive: true, force: true });
}
