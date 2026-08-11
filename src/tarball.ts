/**
 * Reads and rewrites a packed npm tarball. The only place this tool decodes or authors
 * archive bytes, and the only reader every guard consults.
 *
 * The pipeline packs once, with pnpm, because that packer decides the file set. Cleaning the
 * manifest by unpacking and packing again hands that decision to a second packer, which
 * re-derives it from the very field being cleaned and silently disagrees; rewriting the one
 * member that changed keeps the first packer's selection, and its normalisation (uid/gid 0,
 * a fixed mtime, mode 644) that a naive `tar` invocation leaks the build machine's identity
 * into.
 *
 * Every entry other than the manifest is copied as opaque bytes and never decoded, so entry
 * shapes this code does not model — pax extended headers, ustar prefix splitting — survive
 * untouched. Only walking is universal: an entry's length is always its header block plus its
 * size rounded up to a block, whatever the type.
 *
 * Reading here rather than through the `tar` binary is what makes the whole tool depend on
 * nothing but Node: one archive is decompressed once and answers every question about it
 * (file list, manifest bytes, rewrite), instead of one spawn and one decompression per
 * question. It is also the stricter reader — `tar tzf` prints one name per line, so a path
 * containing a newline arrives as two entries there and as itself here.
 */
import { gunzipSync, gzipSync } from "node:zlib";

import { PublishCleanError } from "./error";

const BLOCK = 512;
const NAME_LEN = 100;
const SIZE_OFFSET = 124;
const CHECKSUM_OFFSET = 148;
const TYPE_OFFSET = 156;

/**
 * The manifest is always at this exact path, and at 20 characters it can never be the entry
 * that needs a pax header or a prefix split — so the one entry this code must identify is
 * also the one whose name is guaranteed to be readable straight from the header block.
 */
const MANIFEST_PATH = "package/package.json";

/** Extended (`x`) and global (`g`) pax headers carry key/value overrides for other entries. */
const PAX_TYPES = new Set(["x", "g"]);

/** Tar's flag for a directory entry. Directories are not files a consumer imports. */
const DIRECTORY_TYPE = "5";

/**
 * GNU's long-name entry, whose payload is the real path of the entry that follows it while
 * that entry's own header reads `././@LongLink`.
 *
 * Refused for the same reason a pax `path=` override is: it renames the following entry, so it
 * can point at `package/package.json` and the archive then extracts a manifest no guard here
 * ever saw. pnpm emits pax and never this, so refusing costs nothing and closes the second way
 * to rename an entry onto the one path this tool authors. `K` (long *link* name) is left alone:
 * it renames a symlink target, which cannot collide with an entry path.
 */
const GNU_LONG_NAME = "L";

export interface TarEntry {
  /** Archive path as written, e.g. `package/dist/cli.js`. */
  readonly name: string;
  /** Tar type flag: `0` or empty for a regular file, `5` directory, `2` symlink, `x`/`g` pax. */
  readonly type: string;
  /** Header block, kept whole so a rewrite can reuse every field it does not change. */
  readonly header: Buffer;
  /** Entry contents, without the padding that follows them. */
  readonly body: Buffer;
  /** Header, body and padding as one slice, so copying an entry is byte-exact. */
  readonly raw: Buffer;
}

export interface TarArchive {
  readonly entries: readonly TarEntry[];
  /** The end-of-archive zero blocks and their padding, kept byte for byte. */
  readonly tail: Buffer;
}

function field(block: Buffer, offset: number, length: number): string {
  return block.toString("utf8", offset, offset + length).replace(/\0.*/s, "");
}

function entrySize(block: Buffer): number {
  // A high bit in the first byte marks base-256 encoding, used only for sizes octal cannot
  // express (8GB+). Nothing publishable reaches that, and misreading it would desynchronise
  // the walk and corrupt every following entry, so refuse rather than guess.
  if ((block[SIZE_OFFSET] ?? 0) & 0x80)
    throw new PublishCleanError(
      "Tarball uses base-256 entry sizes, which this tool cannot rewrite.",
    );
  const size = Number.parseInt(field(block, SIZE_OFFSET, 12).trim(), 8);
  if (!Number.isFinite(size) || size < 0)
    throw new PublishCleanError("Tarball entry has an unreadable size field.");
  return size;
}

/**
 * Rejects a pax header that renames another entry onto the manifest path.
 *
 * Without this the archive could extract a `package.json` that no check ever saw: the guards
 * validate the entry rewritten here, while an extractor honours the pax override and writes
 * a different one over it. The header's own name field is `PaxHeader`, so nothing about the
 * substitution is visible from the walk alone.
 */
function assertNoManifestOverride(payload: Buffer): void {
  // pax records are `<len> <key>=<value>\n`, where len counts the whole record.
  for (const record of payload.toString("utf8").split("\n"))
    if (/^\d+ path=/.test(record) && record.slice(record.indexOf("=") + 1) === MANIFEST_PATH)
      throw new PublishCleanError(
        `Tarball contains a pax header renaming an entry to ${MANIFEST_PATH}.`,
      );
}

/** Rebuilds a header for a changed payload size, keeping every other field of the original. */
function reheader(original: Buffer, size: number): Buffer {
  const header = Buffer.from(original);
  header.write(size.toString(8).padStart(11, "0") + "\0", SIZE_OFFSET, 12, "ascii");
  // The checksum is defined over the header with its own field read as eight spaces.
  header.write(" ".repeat(8), CHECKSUM_OFFSET, 8, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", CHECKSUM_OFFSET, 8, "ascii");
  return header;
}

/**
 * Decodes a gzipped tarball into its entries, refusing every shape whose meaning this tool
 * cannot state unambiguously.
 *
 * A duplicate manifest is a refusal rather than a last-one-wins guess, because extractors
 * disagree about which survives and the published manifest would then depend on the extractor
 * rather than on this tool. A short final block is a truncation: an archive that ends
 * mid-entry would otherwise read as a valid one that simply stops, which is exactly how a
 * partial write becomes a published package.
 */
export function readArchive(gzipped: Buffer): TarArchive {
  const tar = gunzipSync(gzipped);
  const entries: TarEntry[] = [];
  let tail: Buffer | null = null;

  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.length < BLOCK)
      throw new PublishCleanError("Tarball ends mid-header; the archive is truncated.");
    const name = field(header, 0, NAME_LEN);
    if (name === "") {
      // Zero block: the end-of-archive marker and its padding, kept byte for byte.
      tail = tar.subarray(offset);
      break;
    }

    const size = entrySize(header);
    const end = offset + BLOCK + BLOCK * Math.ceil(size / BLOCK);
    if (end > tar.length)
      throw new PublishCleanError(`Tarball entry ${name} runs past the end of the archive.`);
    const type = field(header, TYPE_OFFSET, 1);
    const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);

    if (type === GNU_LONG_NAME)
      throw new PublishCleanError("Tarball uses GNU long-name entries, which this tool refuses.");
    if (PAX_TYPES.has(type)) assertNoManifestOverride(body);
    if (name === MANIFEST_PATH) {
      if (type !== "0" && type !== "")
        throw new PublishCleanError(`${MANIFEST_PATH} is not a regular file in the tarball.`);
      if (entries.some((entry) => entry.name === MANIFEST_PATH))
        throw new PublishCleanError(`Tarball contains ${MANIFEST_PATH} more than once.`);
    }

    entries.push({ name, type, header, body, raw: tar.subarray(offset, end) });
    offset = end;
  }

  // An archive ending on an entry boundary with no zero blocks is truncated too, and this is
  // the truncation the walk cannot feel: every entry read cleanly. Refusing it here is also
  // what keeps the rewrite honest, since the output is assembled from these entries plus this
  // tail — with none, it would emit an archive with no end-of-archive marker at all.
  if (tail === null)
    throw new PublishCleanError("Tarball has no end-of-archive marker; the archive is truncated.");
  return { entries, tail };
}

/**
 * The paths a consumer's installer writes, with the `package/` prefix stripped — the list every
 * content guard judges. Directories and pax headers are dropped: neither is a file anyone
 * imports, and a pax header's own name (`PaxHeader`) names no file at all.
 */
export function packageFiles(archive: TarArchive): string[] {
  return archive.entries
    .filter((entry) => entry.type !== DIRECTORY_TYPE && !PAX_TYPES.has(entry.type))
    .map((entry) => (entry.name.startsWith("package/") ? entry.name.slice(8) : entry.name))
    .filter((name) => name.length > 0 && !name.endsWith("/"))
    .sort();
}

function manifestEntry(archive: TarArchive): TarEntry {
  const entry = archive.entries.find((candidate) => candidate.name === MANIFEST_PATH);
  if (!entry) throw new PublishCleanError(`Tarball does not contain ${MANIFEST_PATH}.`);
  return entry;
}

/** The manifest exactly as the archive carries it, for parsing by the caller. */
export function manifestText(archive: TarArchive): string {
  return manifestEntry(archive).body.toString("utf8");
}

/** Returns the gzipped tarball with `package/package.json` replaced by `manifest`. */
export function replaceManifest(archive: TarArchive, manifest: string): Buffer {
  const target = manifestEntry(archive);
  const body = Buffer.from(manifest, "utf8");
  const parts = archive.entries.map((entry) =>
    entry === target
      ? Buffer.concat([
          reheader(entry.header, body.length),
          body,
          Buffer.alloc(BLOCK * Math.ceil(body.length / BLOCK) - body.length),
        ])
      : entry.raw,
  );
  parts.push(archive.tail);
  // Every consumer of this package downloads these bytes forever, and this rewrite decides
  // their compression — not the packer's. `level: 9` is gzip's maximum and the strongest
  // setting the format allows without leaving zlib: measured on this package, it produces
  // 26,440 bytes against 26,699 at the default level 6 and 26,500 as pnpm packed it, for
  // about 1ms. `memLevel: 9` was measured too and rejected: no gain here and 384 bytes
  // WORSE on a 2.5MB corpus. Node writes no mtime into the gzip header, so the output stays
  // byte-identical across runs, which is what lets a re-run repair a release truthfully.
  return gzipSync(Buffer.concat(parts), { level: 9 });
}
