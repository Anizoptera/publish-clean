import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Read once, from the artifact rather than the source, and passed to every assertion below. */
interface CleanedManifest {
  readonly license: string;
  readonly name: string;
  readonly version: string;
  readonly [field: string]: unknown;
}

/**
 * This package promises consumers that installing it pulls in nothing else, and that
 * promise is load-bearing: it sits on the publish path and handles registry credentials,
 * so every transitive package would be code nobody audited holding a live token.
 *
 * The assertion runs against the *cleaned* manifest rather than the source one, because
 * that is the manifest consumers resolve. A dependency added to the source and stripped
 * by the cleaner would be invisible here, and correctly so.
 */
function assertNoRuntimeDependencies(manifest: CleanedManifest): void {
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
 * No shebang assertion, because the tool itself refuses one now (`bin-no-shebang`, src/shipped.ts)
 * and the CLI invoked below IS this package applied to itself. Asserting it again here would be a
 * second, weaker copy — and it would check only this repository, where the rule covers everyone.
 * publint also reports it, which is not the reason: publint is an additional instrument, never a
 * guarantee this project is allowed to lean on.
 */
function assertBannerDeclaresTheArtifact(
  shipped: string,
  { license, name, version }: CleanedManifest,
): void {
  const [, spdx = "", identity = ""] = shipped.split("\n", 3);

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

/**
 * The file the suite ran against and the file the tarball carries must be the same bytes.
 *
 * They are two different builds. The lane builds `dist/cli.js` and `vitest` spawns THAT one; then
 * the CLI below packs with `pnpm`, which runs this package's `prepare` — `tsdown` — so the tarball
 * and publint both read a SECOND build. Measured by planting an old mtime on `dist/cli.js` and
 * watching the tool's own run replace it. They agree today only because the build is reproducible,
 * and nothing else here would notice if it stopped being: the published artifact would simply be one
 * no test ever executed, with every check still green.
 *
 * This is the reproducibility claim in tsdown.config.ts, measured on the axis that matters rather
 * than as a property — which is also why it costs no extra build: the second one already happens.
 */
function assertTestedBytesAreShipped(tested: Buffer, shipped: Buffer): void {
  if (tested.equals(shipped)) return;
  throw new Error(
    `dist/cli.js in the tarball is not the file the tests ran against: ${tested.length} bytes tested, ${shipped.length} shipped.\n` +
      `The pack re-ran the build through \`prepare\` and got different output, so this build is not reproducible ` +
      `and the artifact about to be published is one nothing tested. Find what varies between two \`bun run build\` ` +
      `runs — an embedded timestamp, path, or hash — and remove it.`,
  );
}

/**
 * Every relative link in the SHIPPED README must resolve inside the shipped package.
 *
 * The README is the reference an agent or maintainer reads straight out of `node_modules`, with no
 * repository and no network. Only `dist/`, `README.md`, `LICENSE` and `package.json` are there, so
 * a link to `docs/…`, `src/…` or `CONTRIBUTING.md` is dead for the reader it was written for — and
 * dead on the npm package page too, which resolves relative links against the registry. Point at
 * the repository with a full URL instead.
 *
 * Checked against the extracted artifact rather than the `files` field, so it measures what a
 * consumer actually receives instead of what the manifest promises.
 */
function assertReadmeLinksResolveOffline(artifact: string): void {
  const readme = readFileSync(path.join(artifact, "README.md"), "utf8");
  const dead = [...readme.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1] ?? "")
    .filter((target) => !/^(?:[a-z]+:|#)/.test(target))
    .map((target) => target.split("#")[0] ?? "")
    .filter((target) => target !== "" && !existsSync(path.join(artifact, target)));
  if (dead.length > 0)
    throw new Error(
      `README.md ships these relative links, and none of them exists in the installed package:\n` +
        `${[...new Set(dead)].map((target) => `  ${target}`).join("\n")}\n` +
        `Use https://github.com/Anizoptera/publish-clean/blob/main/<path> so the link works from ` +
        `node_modules and on the npm page.`,
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

// Read BEFORE the CLI runs: its `pnpm pack` re-runs `prepare`, which overwrites this file.
const tested = readFileSync("dist/cli.js");

// The CLI keeps no temp tree, so this script names its own and deletes it.
// publint reads the extracted package, so the tarball is unpacked here.
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

  const manifest = JSON.parse(
    readFileSync(path.join(artifact, "package.json"), "utf8"),
  ) as CleanedManifest;
  const shipped = readFileSync(path.join(artifact, "dist", "cli.js"));

  assertNoRuntimeDependencies(manifest);
  assertTestedBytesAreShipped(tested, shipped);
  assertBannerDeclaresTheArtifact(shipped.toString("utf8"), manifest);
  assertReadmeLinksResolveOffline(artifact);
  run("bunx", ["publint", "run", artifact, "--pack", "false"]);
} finally {
  rmSync(root, { recursive: true, force: true });
}
