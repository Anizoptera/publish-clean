/**
 * The rewriter is the one place this tool authors archive bytes rather than copying them, so
 * these cases attack the encoding directly: entry shapes it must carry through untouched, and
 * the ambiguities it must refuse instead of guessing at. Archives are built here by hand
 * rather than by packing a fixture, because a packer will not emit the malformed and hostile
 * shapes that matter, and a case that has to run one costs a thousand times what it proves.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { packageFiles, readArchive, replaceManifest } from "../src/tarball";

const BLOCK = 512;

interface Entry {
  name: string;
  body: string;
  type?: string;
}

/** Builds a minimal ustar archive, computing the header checksum the way readers verify it. */
function archive(entries: readonly Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, body, type = "0" } of entries) {
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write(Buffer.byteLength(body).toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write(" ".repeat(8), 148, 8, "ascii");
    header.write(type, 156, 1, "ascii");
    header.write("ustar\0" + "00", 257, 8, "ascii");
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

const MANIFEST = "package/package.json";

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

  it("carries through entry shapes it does not model", () => {
    // A pax header and its renamed entry: the real path lives in the pax payload, so the
    // walk must copy both without interpreting either. pnpm emits exactly this for any path
    // longer than 255 characters.
    const source = archive([
      { name: "PaxHeader", body: `285 path=package/lib/${"d".repeat(260)}.js\n`, type: "x" },
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
      { name: "PaxHeader", body: `29 path=${MANIFEST}\n`, type: "x" },
      { name: "package/decoy", body: `{"name":"evil"}` },
      { name: MANIFEST, body: "{}" },
    ]);
    expect(() => replaceManifest(readArchive(source), "{}")).toThrow(/renaming an entry/);
  });

  it("refuses a GNU long-name entry, the other way to rename onto the manifest", () => {
    // Same substitution as the pax case, in the encoding pnpm does not emit: the real path
    // is the payload of this entry and the next entry's header carries only a placeholder,
    // so a walk that reads header names alone cannot see where it points.
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
      { name: "PaxHeader/package/a.js", body: "30 mtime=1700000000.0\n", type: "x" },
      { name: "package/a.js", body: "a" },
    ]);
    expect(packageFiles(readArchive(source))).toEqual(["a.js"]);
  });
});
