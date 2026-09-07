/** A release must fail before irreversible work when its identity or artifact evidence disagrees. */
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { assertRegistryArtifact, registryIntegrity, releasePlan } from "../scripts/release";

const pkg = { name: "fixture", version: "1.2.3" };
const notes = "## [1.2.3] - 2026-01-01\n\nChanged behavior.\n\n## [1.2.2]\nOld behavior.\n";

describe("release preconditions", () => {
  it.each(["refs/heads/v1.2.3", "refs/tags/v1.2.4", "", "refs/heads/main"])(
    "refuses ref %j",
    (ref) => {
      expect(() => releasePlan(pkg, ref, notes)).toThrow(/refs\/tags\/v1.2.3/);
    },
  );
  it.each(["", "## [1.2.3]\n\n## [1.2.2]\nOld", `${notes}\n## [1.2.3]\nDuplicate`])(
    "refuses missing, empty or duplicate notes",
    (changelog) => {
      expect(() => releasePlan(pkg, "refs/tags/v1.2.3", changelog)).toThrow(/CHANGELOG/);
    },
  );
  it("preserves the selected notes and ignores headings in fenced examples", () => {
    const body = "Before.\n```md\n## [1.2.3]\n```\nAfter.";
    expect(releasePlan(pkg, "refs/tags/v1.2.3", `## [1.2.3]\n${body}\n## [1.2.2]\nOld`).notes).toBe(
      body,
    );
  });
  it.each([
    ["1.2.3", "latest"],
    ["1.2.3-rc.1", "next"],
    ["1.2.3+build-a", "latest"],
  ])("derives the tag for %s", (version, tag) => {
    expect(
      releasePlan({ ...pkg, version }, `refs/tags/v${version}`, `## [${version}]\nNotes`).tag,
    ).toBe(tag);
  });
  it("refuses a candidate that differs from registry bytes", () => {
    // SHA-512('abc'), a published standard test vector, independent of the implementation.
    const integrity =
      "sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==";
    expect(() => assertRegistryArtifact(Buffer.from("abc"), integrity)).not.toThrow();
    expect(() => assertRegistryArtifact(Buffer.from("abd"), integrity)).toThrow(/differs/);
    expect(() => assertRegistryArtifact(Buffer.from("abc"), null)).toThrow(/differs/);
  });
});

it("distinguishes an absent version from registry failure and incomplete metadata", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    const status = request.url === "/missing" ? 404 : request.url === "/outage" ? 503 : 200;
    response.writeHead(status);
    response.end(
      JSON.stringify(request.url === "/published" ? { dist: { integrity: "sha512-fixture" } } : {}),
    );
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No loopback port");
    const url = `http://127.0.0.1:${address.port}`;
    await expect(registryIntegrity(`${url}/missing`)).resolves.toBeNull();
    await expect(registryIntegrity(`${url}/outage`)).rejects.toThrow(/503/);
    await expect(registryIntegrity(`${url}/malformed`)).rejects.toThrow(/dist.integrity/);
    await expect(registryIntegrity(`${url}/published`)).resolves.toBe("sha512-fixture");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
