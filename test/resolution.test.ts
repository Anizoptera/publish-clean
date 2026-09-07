/** Compare path guards with Node's consumer resolver, including valid fallbacks and invalid targets. */
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { assertDeclaredFiles } from "../src/artifact";
import type { JsonObject } from "../src/json";

it.concurrent.each([
  { manifest: { main: "./index" }, files: { "index.js": "module.exports = 42" } },
  { manifest: { main: "./lib/" }, files: { "lib/index.js": "module.exports = 42" } },
  { manifest: { main: "." }, files: { "index.js": "module.exports = 42" } },
  { manifest: { main: "lib" }, files: { "lib/index": "module.exports = 42" }, broken: true },
  {
    manifest: { main: "lib" },
    files: { "lib/package.json": '{"main":"entry"}', "lib/entry.js": "module.exports = 42" },
    broken: true,
  },
  {
    manifest: { exports: ["not-a-local-target", "./index.js"] },
    files: { "index.js": "module.exports = 42" },
  },
  {
    manifest: { exports: "./with%20space.js?variant" },
    files: { "with space.js": "module.exports = 42" },
  },
])("agrees with Node on entry point $manifest", async ({ manifest, files, broken }) => {
  const root = await mkdtemp(path.join(tmpdir(), "publish-clean-resolve-"));
  const dir = path.join(root, "node_modules", "fixture");
  try {
    const contents: Record<string, string> = {
      ...files,
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", ...manifest }),
    };
    await Promise.all(
      Object.entries(contents).map(async ([name, body]) => {
        await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
        await writeFile(path.join(dir, name), body);
      }),
    );
    const consume = () => createRequire(path.join(root, "consumer.cjs"))("fixture");
    const guard = () => assertDeclaredFiles(manifest, Object.keys(contents));
    if (broken) {
      expect(consume).toThrow(/Cannot find module/);
      expect(guard).toThrow(/missing/);
    } else {
      expect(consume()).toBe(42);
      expect(guard).not.toThrow();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.concurrent.each([
  "not-a-local-target",
  "./lib/../index.js",
  "./%2e%2e/index.js",
  "./node_modules/index.js",
])("rejects a target Node refuses: %s", async (target) => {
  const root = await mkdtemp(path.join(tmpdir(), "publish-clean-invalid-target-"));
  const dir = path.join(root, "node_modules", "fixture");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fixture", exports: target }),
    );
    await writeFile(path.join(dir, "index.js"), "module.exports = 42");
    expect(() => createRequire(path.join(root, "consumer.cjs"))("fixture")).toThrow(/Invalid/);
    expect(() => assertDeclaredFiles({ exports: target }, ["index.js"])).toThrow(
      /invalid package paths/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("checks wildcard substitutions and reachable conditional array branches", () => {
  expect(() => assertDeclaredFiles({ exports: { "./*": "./missing/*.js" } }, ["index.js"])).toThrow(
    /missing/,
  );
  expect(() => assertDeclaredFiles({ exports: { "./*": "./lib/*-*.js" } }, ["lib/a-b.js"])).toThrow(
    /missing/,
  );
  expect(() =>
    assertDeclaredFiles({ exports: { "./*": "./lib/*-*.js" } }, ["lib/a-a.js"]),
  ).not.toThrow();
  const manifest: JsonObject = {
    exports: [{ node: "./missing.js", default: "invalid" }, "./index.js"],
  };
  expect(() => assertDeclaredFiles(manifest, ["index.js"])).toThrow(/missing/);
  expect(() => assertDeclaredFiles({ imports: { "#dep": "external-package" } }, [])).not.toThrow();
});
