/**
 * The rewriter is the one place this tool authors archive bytes rather than copying them, so
 * these cases attack the encoding directly: entry shapes it must carry through untouched, and
 * the ambiguities it must refuse instead of guessing at. Archives are built here by hand
 * rather than by packing a fixture, because a packer will not emit the malformed and hostile
 * shapes that matter, and a case that has to run one costs a thousand times what it proves.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  assertPreservedArchive,
  manifestText,
  packageFiles,
  readArchive,
  replaceManifest,
} from "../src/tarball";

const BLOCK = 512;

interface Entry {
  name: string;
  body: string;
  type?: string;
  prefix?: string;
  size?: number;
}

/** Builds a minimal ustar archive, computing the header checksum the way readers verify it. */
function archive(entries: readonly Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, body, type = "0", prefix = "", size = Buffer.byteLength(body) } of entries) {
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write(" ".repeat(8), 148, 8, "ascii");
    header.write(type, 156, 1, "ascii");
    header.write("ustar\0" + "00", 257, 8, "ascii");
    header.write(prefix, 345, 155, "utf8");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    const payload = Buffer.from(body, "utf8");
    blocks.push(
      header,
      payload,
      Buffer.alloc(BLOCK * Math.ceil(payload.length / BLOCK) - payload.length),
    );
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(blocks));
}

/** Reads back name/body pairs, so a case can assert on content rather than on offsets. */
function entries(tgz: Buffer): Record<string, string> {
  const tar = gunzipSync(tgz);
  const found: Record<string, string> = {};
  for (let offset = 0; offset < tar.length;) {
    const name = tar.toString("utf8", offset, offset + 100).replace(/\0.*/s, "");
    if (name === "") break;
    const size = Number.parseInt(tar.toString("utf8", offset + 124, offset + 136).trim(), 8);
    found[name] = tar.toString("utf8", offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + BLOCK * Math.ceil(size / BLOCK);
  }
  return found;
}

function pax(key: string, value: string): string {
  const record = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(record) + 1;
  while (String(length).length + Buffer.byteLength(record) !== length)
    length = String(length).length + Buffer.byteLength(record);
  return `${length}${record}`;
}

const MANIFEST = "package/package.json";

it("does not mistake a metadata header's name for the manifest member", () => {
  const source = readArchive(
    archive([
      { name: MANIFEST, type: "x", body: pax("mtime", "0") },
      { name: MANIFEST, body: '{"name":"fixture"}' },
    ]),
  );
  expect(manifestText(source)).toBe('{"name":"fixture"}');
  const rewritten = readArchive(replaceManifest(source, "{}"));
  expect(manifestText(rewritten)).toBe("{}");
  expect(() => assertPreservedArchive(source, rewritten)).not.toThrow();
  expect(rewritten.entries[0]?.raw.equals(source.entries[0]?.raw ?? Buffer.alloc(0))).toBe(true);
});

describe("manifest rewriting", () => {
  it("replaces only the manifest and leaves every neighbour byte-identical", () => {
    const source = archive([
      { name: "package/lib/a.js", body: "a\n" },
      { name: MANIFEST, body: `{"name":"x","files":["lib"]}` },
      { name: "package/lib/b.js", body: "b\n" },
    ]);
    const result = entries(replaceManifest(readArchive(source), `{"name":"x"}`));
    expect(result).toEqual({
      "package/lib/a.js": "a\n",
      [MANIFEST]: `{"name":"x"}`,
      "package/lib/b.js": "b\n",
    });
  });

  it("keeps the archive readable when the manifest grows past a block boundary", () => {
    // Padding is what a size change actually moves, and getting it wrong desynchronises every
    // following entry rather than corrupting the manifest visibly.
    const grown = JSON.stringify({ name: "x", description: "d".repeat(900) });
    const source = archive([
      { name: MANIFEST, body: "{}" },
      { name: "package/lib/a.js", body: "a\n" },
    ]);
    const result = entries(replaceManifest(readArchive(source), grown));
    expect(result[MANIFEST]).toBe(grown);
    expect(result["package/lib/a.js"]).toBe("a\n");
  });

  it("preserves PAX paths and payloads while rewriting the manifest", () => {
    const source = archive([
      { name: "PaxHeader", body: pax("path", `package/lib/${"d".repeat(260)}.js`), type: "x" },
      { name: "PaxHeader", body: "deep\n" },
      { name: MANIFEST, body: "{}" },
    ]);
    const result = replaceManifest(readArchive(source), `{"name":"x"}`);
    expect(entries(result)["PaxHeader"]).toBe("deep\n");
    expect(gunzipSync(result).length).toBe(gunzipSync(source).length);
  });

  it("refuses a pax header that renames another entry onto the manifest path", () => {
    // Otherwise the archive extracts a manifest no guard ever saw: the checks read the entry
    // rewritten here while an extractor honours the override and writes a different one.
    const source = archive([
      { name: "PaxHeader", body: pax("path", MANIFEST), type: "x" },
      { name: "package/decoy", body: `{"name":"evil"}` },
      { name: MANIFEST, body: "{}" },
    ]);
    expect(() => replaceManifest(readArchive(source), "{}")).toThrow(/renaming an entry/);
  });

  it("refuses a GNU long-name entry, the other way to rename onto the manifest", () => {
    // Same substitution as the pax case, in the encoding pnpm 12 emits where pnpm 11 wrote a
    // pax header: the real path is the payload of this entry and the next entry's header
    // carries only a placeholder, so a walk that reads header names alone cannot see where
    // it points. Reading the name is what lets this be a refusal rather than a blind pass.
    const source = archive([
      { name: "././@LongLink", body: `${MANIFEST}\0`, type: "L" },
      { name: "package/decoy", body: `{"name":"evil"}` },
      { name: MANIFEST, body: "{}" },
    ]);
    expect(() => replaceManifest(readArchive(source), "{}")).toThrow(/GNU long-name/);
  });

  it("refuses a duplicated manifest rather than guessing which one an extractor keeps", () => {
    const source = archive([
      { name: MANIFEST, body: `{"name":"first"}` },
      { name: MANIFEST, body: `{"name":"second"}` },
    ]);
    expect(() => replaceManifest(readArchive(source), "{}")).toThrow(/more than once/);
  });

  it("refuses an archive with no manifest instead of publishing one without", () => {
    expect(() =>
      replaceManifest(readArchive(archive([{ name: "package/a.js", body: "a\n" }])), "{}"),
    ).toThrow(/does not contain/);
  });

  it("refuses a manifest entry that is not a regular file", () => {
    // A symlink here would publish a manifest whose content depends on the extraction target.
    const source = archive([{ name: MANIFEST, body: "", type: "2" }]);
    expect(() => replaceManifest(readArchive(source), "{}")).toThrow(/not a regular file/);
  });
});

/**
 * The reader replaced four `tar` subprocesses, so these cases hold it to what that binary
 * guaranteed and to what it could not: a truncated archive must be refused rather than read
 * as one that simply ended, and the file list must survive names `tar tzf`'s line-per-name
 * output cannot express.
 */
describe("archive reading", () => {
  /** Re-gzips a prefix of the decoded bytes, the shape a partial write leaves on disk. */
  function truncated(source: Buffer, bytes: number): Buffer {
    return gzipSync(gunzipSync(source).subarray(0, bytes));
  }

  it("refuses an archive whose entry runs past the end", () => {
    const source = archive([{ name: "package/a.js", body: "x".repeat(600) }]);
    expect(() => readArchive(truncated(source, BLOCK + 600))).toThrow(/runs past the end/);
  });

  it("refuses an archive that stops inside a header", () => {
    const source = archive([
      { name: "package/a.js", body: "a" },
      { name: "package/b.js", body: "b" },
    ]);
    expect(() => readArchive(truncated(source, BLOCK * 2 + 100))).toThrow(/truncated/);
  });

  // The truncation the walk cannot feel: every entry reads cleanly and the archive simply
  // stops. Left unrefused, the rewrite would emit an archive with no end-of-archive marker,
  // built from entries that were all individually valid.
  it("refuses an archive that stops on an entry boundary, with no end marker", () => {
    const source = archive([{ name: "package/a.js", body: "a" }]);
    const withoutMarker = gunzipSync(source).subarray(0, BLOCK * 2);
    expect(() => readArchive(gzipSync(withoutMarker))).toThrow(/no end-of-archive marker/);
  });

  // The rewriter authors one header block and computes its checksum, so a reader that never
  // verifies one lets that computation vouch for itself. Reading the written artifact back
  // is what turns this into a check on the bytes this tool wrote.
  it("refuses a header whose stored checksum does not match its bytes", () => {
    const source = gunzipSync(archive([{ name: "package/a.js", body: "a" }]));
    source.write("package/b.js", 0, 100, "utf8");
    expect(() => readArchive(gzipSync(source))).toThrow(/corrupt header checksum/);
  });

  it("keeps a filename a line-based listing would split in two", () => {
    const source = archive([{ name: "package/we\nird.js", body: "x" }]);
    expect(packageFiles(readArchive(source))).toEqual(["we\nird.js"]);
  });

  it("lists only files: no directories, no pax headers", () => {
    const source = archive([
      { name: "package/dir/", body: "", type: "5" },
      { name: "PaxHeader/package/a.js", body: pax("mtime", "1700000000.0"), type: "x" },
      { name: "package/a.js", body: "a" },
    ]);
    expect(packageFiles(readArchive(source))).toEqual(["a.js"]);
  });
});

describe("effective archive entries", () => {
  it("reads USTAR prefixes and byte-counted PAX paths containing Unicode and newlines", () => {
    const deep = `package/${"deep/".repeat(60)}é\nsecret.pem`;
    const input = archive([
      { name: "secret.key", prefix: "package/dist", body: "key" },
      { name: "PaxHeader", type: "x", body: pax("path", deep) + pax("mtime", "0") },
      { name: "PaxHeader", body: "secret" },
    ]);
    expect(packageFiles(readArchive(input))).toEqual([deep.slice(8), "dist/secret.key"]);
  });

  // pnpm 12 writes these wherever a path is too long for the USTAR name/prefix split, which is
  // where pnpm 11 wrote a pax header. Refusing them outright — as this tool did while no packer
  // it supports emitted any — rejects correct packages; the guarantee that mattered was never
  // the refusal but that no name reaches a guard unread.
  it("reads a GNU long name as the effective path of the entry that follows it", () => {
    const deep = `package/dist/${"d".repeat(70)}/${"e".repeat(70)}/secret.pem`;
    const input = archive([
      { name: "././@LongLink", type: "L", body: `${deep}\0` },
      { name: "package/dist/truncated-placeholder", body: "secret" },
      { name: MANIFEST, body: "{}" },
    ]);
    // The long-name header is not a file anyone installs, and the member it names is judged by
    // the path it actually extracts to — not by the placeholder in its own header.
    expect(packageFiles(readArchive(input))).toEqual([deep.slice(8), "package.json"]);
  });

  it("refuses a GNU long name that escapes the package directory", () => {
    const input = archive([
      { name: "././@LongLink", type: "L", body: "package/../../etc/passwd\0" },
      { name: "package/harmless.js", body: "x" },
      { name: MANIFEST, body: "{}" },
    ]);
    expect(() => readArchive(input)).toThrow(/unsafe entry path/);
  });

  it("refuses an empty GNU long name, which leaves the next entry's path unstated", () => {
    // Falling back to the placeholder in the next header would judge the member under a name
    // it does not extract to — the same blind spot reading the long name exists to close.
    const input = archive([
      { name: "././@LongLink", type: "L", body: "\0" },
      { name: "package/placeholder", body: "a" },
      { name: MANIFEST, body: "{}" },
    ]);
    expect(() => readArchive(input)).toThrow(/empty GNU long-name/);
  });

  it("refuses a pax header and a GNU long name competing for one entry", () => {
    // Both claim to state the next entry's path, and nothing in either format says which an
    // extractor honours, so the effective name would be the extractor's opinion rather than
    // this tool's reading.
    const input = archive([
      { name: "PaxHeader", type: "x", body: pax("path", "package/one.js") },
      { name: "././@LongLink", type: "L", body: "package/two.js\0" },
      { name: "package/placeholder", body: "x" },
      { name: MANIFEST, body: "{}" },
    ]);
    expect(() => readArchive(input)).toThrow(/consecutive extended headers/);
  });

  it("uses PAX size when walking an entry and resets it before the next entry", () => {
    const input = archive([
      { name: "PaxHeader", type: "x", body: pax("size", "600") },
      { name: "package/large", body: "a".repeat(600), size: 0 },
      { name: MANIFEST, body: "{}" },
    ]);
    const parsed = readArchive(input);
    expect(parsed.entries[1]?.body.length).toBe(600);
    const result = readArchive(replaceManifest(parsed, '{"name":"x"}'));
    expect(() => assertPreservedArchive(parsed, result)).not.toThrow();
    expect(packageFiles(result)).toEqual(["large", "package.json"]);
  });

  it.each(["0 path=x\n", "8 path=x\n", "999 path=x\n", "x path=x\n", "12 path=x\nJUNK"])(
    "rejects malformed PAX framing %j",
    (body) => {
      expect(() =>
        readArchive(
          archive([
            { name: "PaxHeader", type: "x", body },
            { name: MANIFEST, body: "{}" },
          ]),
        ),
      ).toThrow(/malformed PAX/);
    },
  );

  it("rejects a stale PAX manifest size and forbidden global path overrides", () => {
    for (const entry of [
      { name: "PaxHeader", type: "x", body: pax("size", "2") },
      { name: "PaxHeader", type: "g", body: pax("path", "package/hidden.pem") },
    ])
      expect(() => readArchive(archive([entry, { name: MANIFEST, body: "{}" }]))).toThrow(/PAX/);
  });

  it.each([
    "package/../secret",
    "package/./package.json",
    "package//package.json",
    "/package/a",
    "package/a\\b",
  ])("rejects extraction aliases %j", (name) => {
    expect(() => readArchive(archive([{ name, body: "x" }]))).toThrow(/unsafe entry path/);
  });

  it("rejects duplicate effective paths even when their raw names differ", () => {
    expect(() =>
      readArchive(
        archive([
          { name: "package/a", body: "a" },
          { name: "PaxHeader", type: "x", body: pax("path", "package/a") },
          { name: "placeholder", body: "b" },
        ]),
      ),
    ).toThrow(/more than once/);
  });

  it("rejects hidden bytes after the end marker and a single zero block", () => {
    const bytes = gunzipSync(archive([{ name: MANIFEST, body: "{}" }]));
    expect(() => readArchive(gzipSync(bytes.subarray(0, bytes.length - BLOCK)))).toThrow(
      /end-of-archive/,
    );
    bytes[bytes.length - 1] = 1;
    expect(() => readArchive(gzipSync(bytes))).toThrow(/end-of-archive/);
  });

  it("detects payload changes, entry reordering, duplication and header changes", () => {
    const base = [
      { name: MANIFEST, body: "{}" },
      { name: "package/a", body: "a" },
      { name: "package/b", body: "b" },
    ] as const;
    const original = readArchive(archive(base));
    for (const changed of [
      [base[0], { name: "package/a", body: "changed" }, base[2]],
      [base[0], base[2], base[1]],
      [base[0], base[1]],
      [base[0], { name: "a", prefix: "package", body: "a" }, base[2]],
    ])
      expect(() => assertPreservedArchive(original, readArchive(archive(changed)))).toThrow(
        /changed/,
      );
  });
});
