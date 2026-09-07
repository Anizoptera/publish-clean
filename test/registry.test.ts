/** Compare npm's loopback upload with the validated bytes without contacting an external registry. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("uploads the checked bytes to the explicit registry despite a conflicting scope registry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publish-clean-registry-"));
  const uploads: { url: string; name: string; bytes: Buffer }[] = [];
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "PUT") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        name: string;
        _attachments: Record<string, { data: string }>;
      };
      const attachments = Object.values(body._attachments);
      expect(attachments).toHaveLength(1);
      for (const attachment of attachments)
        uploads.push({
          url: request.url ?? "",
          name: body.name,
          bytes: Buffer.from(attachment.data, "base64"),
        });
      response.writeHead(201, { "content-type": "application/json" });
      response.end('{"ok":true}');
    } catch (error) {
      failures.push(error);
      response.writeHead(500);
      response.end();
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No loopback port");
    const origin = `http://127.0.0.1:${address.port}`;
    const pkg = path.join(root, "pkg");
    const out = path.join(root, "out");
    await mkdir(pkg);
    await writeFile(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "@audit/registry-fixture",
        version: "1.0.0",
        files: ["index.js"],
        publishConfig: { provenance: true },
      }),
    );
    await writeFile(path.join(pkg, "index.js"), "module.exports = 42;\n");
    await writeFile(
      path.join(pkg, ".npmrc"),
      `@audit:registry=${origin}/wrong/\n//127.0.0.1:${address.port}/chosen/:_authToken=local-fixture-only\n`,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      npm_config_userconfig: path.join(root, "empty-npmrc"),
      npm_config_cache: path.join(root, "cache"),
    };
    delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete env.GITHUB_ACTIONS;
    const invoke = (forwarded: string[]) =>
      new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(
          "node",
          [
            path.resolve("dist/cli.js"),
            "--no-git-checks",
            "--registry",
            `${origin}/chosen/`,
            "--tarball-out",
            out,
            pkg,
            "--",
            ...forwarded,
          ],
          { env, timeout: 10_000, killSignal: "SIGKILL" },
        );
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, output }));
      });
    const rejected = await Promise.all(
      [
        ["--workspaces", "."],
        ["--tag=--workspace", "."],
        ["elsewhere.tgz"],
        ["--registry=https://fixture-secret@example.test"],
      ].map(invoke),
    );
    for (const result of rejected) {
      expect(result.code).not.toBe(0);
      expect(result.output).not.toContain("fixture-secret");
    }
    expect(uploads).toHaveLength(0);
    const manifestPath = path.join(pkg, "package.json");
    const original = await readFile(manifestPath, "utf8");
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...JSON.parse(original),
        publishConfig: { "@other:registry": "https://fixture-secret@example.test" },
      }),
    );
    const credentialFailure = await invoke(["--dry-run"]);
    expect(credentialFailure.code).not.toBe(0);
    expect(credentialFailure.output).toContain("Registry URLs must not contain credentials");
    expect(credentialFailure.output).not.toContain("fixture-secret");
    expect(uploads).toHaveLength(0);
    await writeFile(manifestPath, original);
    const result = await invoke(["--access", "public", "--ignore-scripts", "--no-provenance"]);
    expect(result.code, result.output).toBe(0);
    expect(failures).toEqual([]);
    expect(uploads).toHaveLength(1);
    const uploaded = uploads[0];
    expect(uploaded?.url).toBe("/chosen/@audit%2fregistry-fixture");
    expect(uploaded?.name).toBe("@audit/registry-fixture");
    const files = await readdir(out);
    expect(files).toHaveLength(1);
    expect(uploaded?.bytes).toEqual(await readFile(path.join(out, files[0] ?? "missing")));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
