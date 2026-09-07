/** Validate release identity before upload and require registry byte identity before attesting a rerun. */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { run } from "../src/command";
import { isObject } from "../src/json";
import type { JsonObject } from "../src/json";

export function releasePlan(pkg: JsonObject, ref: string, changelog: string) {
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string")
    throw new Error("Release package.json must declare a name and version.");
  if (ref !== `refs/tags/v${pkg.version}`)
    throw new Error(`Release must run from refs/tags/v${pkg.version}; received ${ref}.`);
  const lines = changelog.split(/\r?\n/);
  const sections: { version: string; start: number; end: number }[] = [];
  let fence: string | undefined;
  for (const [index, line] of lines.entries()) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (
        delimiter?.startsWith(fence[0] ?? "") &&
        delimiter.length >= fence.length &&
        line.trim() === delimiter
      )
        fence = undefined;
      continue;
    }
    if (delimiter) {
      fence = delimiter;
      continue;
    }
    if (!line.startsWith("## ")) continue;
    const previous = sections.at(-1);
    if (previous) previous.end = index;
    const end = line.indexOf("]", 4);
    sections.push({
      version: line.startsWith("## [") && end >= 4 ? line.slice(4, end) : "",
      start: index + 1,
      end: lines.length,
    });
  }
  const matches = sections.filter((section) => section.version === pkg.version);
  const section = matches[0];
  if (matches.length !== 1 || !section)
    throw new Error(`CHANGELOG.md must have exactly one ## [${pkg.version}] section.`);
  const notes = lines.slice(section.start, section.end).join("\n").trim();
  if (!notes) throw new Error(`CHANGELOG.md has an empty ${pkg.version} section.`);
  return {
    name: pkg.name,
    version: pkg.version,
    notes,
    tag: pkg.version.split("+")[0]?.includes("-") ? "next" : "latest",
  };
}

/** A registry outage is not evidence that a version is unpublished. */
export async function registryIntegrity(url: string): Promise<string | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`Cannot check published version: registry returned HTTP ${response.status}.`);
  const manifest: unknown = await response.json();
  if (
    !isObject(manifest) ||
    !isObject(manifest.dist) ||
    typeof manifest.dist.integrity !== "string"
  )
    throw new Error(
      "Registry version response has no dist.integrity; refusing to guess artifact identity.",
    );
  return manifest.dist.integrity;
}

export function assertRegistryArtifact(bytes: Buffer, expected: string | null): void {
  const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (expected === null || !expected.split(/\s+/).includes(actual))
    throw new Error(
      "Candidate tarball differs from registry dist.integrity; do not attest or replace release assets.",
    );
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "preflight" && mode !== "publish")
    throw new Error("Use release.ts preflight or publish.");
  const pkg: unknown = JSON.parse(await readFile("package.json", "utf8"));
  if (!isObject(pkg)) throw new Error("package.json must be an object.");
  const plan = releasePlan(
    pkg,
    process.env.GITHUB_REF ?? "",
    await readFile("CHANGELOG.md", "utf8"),
  );
  const out = path.resolve("release-artifacts");
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "notes.md"), `${plan.notes}\n`);
  if (mode === "preflight") return;

  const url = `https://registry.npmjs.org/${encodeURIComponent(plan.name)}/${encodeURIComponent(plan.version)}`;
  const existing = await registryIntegrity(url);
  // Use the pinned Bun for both first publication and repair; different gzip encoders
  // can produce different bytes from the same source. The digest, not this pin, is proof.
  await run(
    process.execPath,
    [
      "dist/cli.js",
      ...(existing === null ? [] : ["--dry-run"]),
      "--tarball-out",
      out,
      "--registry",
      "https://registry.npmjs.org",
      "--",
      "--access",
      "public",
      "--tag",
      plan.tag,
      "--provenance",
    ],
    process.cwd(),
    { output: "publish" },
  );
  const tarballs = (await readdir(out)).filter((file) => file.endsWith(".tgz"));
  const tarball = tarballs[0];
  if (tarballs.length !== 1 || !tarball) throw new Error("Expected exactly one release tarball.");
  assertRegistryArtifact(
    await readFile(path.join(out, tarball)),
    existing ?? (await registryIntegrity(url)),
  );
}

if (import.meta.main) await main();
