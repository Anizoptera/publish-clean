/** Read effective archive paths and rewrite only the manifest, preserving every other raw entry. */
import { gunzipSync, gzipSync } from "node:zlib";

import { PublishCleanError } from "./error";

const BLOCK = 512;
const NAME_LEN = 100;
const SIZE_OFFSET = 124;
const CHECKSUM_OFFSET = 148;
const TYPE_OFFSET = 156;

const MANIFEST_PATH = "package/package.json";
const PAX_TYPES = new Set(["x", "g"]);
const DIRECTORY_TYPE = "5";
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export interface TarEntry {
  /** Effective archive path after USTAR/PAX interpretation, e.g. `package/dist/cli.js`. */
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
  const bytes = block.subarray(offset, offset + length);
  const nul = bytes.indexOf(0);
  return UTF8.decode(nul < 0 ? bytes : bytes.subarray(0, nul));
}

function entrySize(block: Buffer): number {
  const value = field(block, SIZE_OFFSET, 12).trim();
  if (!/^[0-7]+$/.test(value))
    throw new PublishCleanError("Tarball entry has an unreadable size field.");
  return Number.parseInt(value, 8);
}

/** PAX lengths count bytes, including their own digits; values may contain newlines. */
function paxFields(payload: Buffer): Map<string, string> {
  const fields = new Map<string, string>();
  for (let offset = 0; offset < payload.length;) {
    const space = payload.indexOf(0x20, offset);
    const digits = payload.toString("ascii", offset, space < 0 ? offset : space);
    const length = Number(digits);
    const end = offset + length;
    const equals = payload.indexOf(0x3d, space + 1);
    if (
      !/^[1-9][0-9]*$/.test(digits) ||
      !Number.isSafeInteger(length) ||
      end > payload.length ||
      equals <= space + 1 ||
      equals >= end - 1 ||
      payload[end - 1] !== 0x0a
    )
      throw new PublishCleanError("Tarball has a malformed PAX record.");
    const key = UTF8.decode(payload.subarray(space + 1, equals));
    const value = UTF8.decode(payload.subarray(equals + 1, end - 1));
    if (key.includes("sparse") || key === "hdrcharset")
      throw new PublishCleanError(`Tarball uses unsupported PAX ${key}.`);
    fields.set(key, value);
    offset = end;
  }
  return fields;
}

/**
 * Verifies a header block against the checksum tar stores inside it.
 *
 * This is the format's own integrity check over the 512 bytes that say where an entry starts,
 * how long it is and what it is called — the fields a walk trusts absolutely. The gzip CRC
 * already covers every byte of the archive, so on a packed tarball this is redundant; it is
 * here because the rewrite AUTHORS one of these blocks, and a checksum nothing verifies is a
 * value vouching for itself. Reading the written artifact back runs this over that block.
 *
 * Both sums are accepted because tar has two historical conventions: the standard sums the
 * bytes unsigned, while older implementations summed them as signed chars. The two agree for
 * every all-ASCII header and diverge the moment a name carries a byte above 127, so refusing
 * the signed form would reject valid archives holding non-ASCII filenames.
 */
function assertChecksum(header: Buffer, name: string): void {
  const stored = Number.parseInt(field(header, CHECKSUM_OFFSET, 8).trim(), 8);
  let unsigned = 0;
  let signed = 0;
  for (const [index, byte] of header.entries()) {
    // The checksum is defined over the header with its own field read as eight spaces.
    const value = index >= CHECKSUM_OFFSET && index < CHECKSUM_OFFSET + 8 ? 0x20 : byte;
    unsigned += value;
    signed += value > 127 ? value - 256 : value;
  }
  if (stored !== unsigned && stored !== signed)
    throw new PublishCleanError(`Tarball entry ${name} has a corrupt header checksum.`);
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
  const names = new Set<string>();
  let local: Map<string, string> | null = null;
  let tail: Buffer | null = null;

  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.length < BLOCK)
      throw new PublishCleanError("Tarball ends mid-header; the archive is truncated.");
    if (header.every((byte) => byte === 0)) {
      tail = tar.subarray(offset);
      if (tail.length < BLOCK * 2 || tail.length % BLOCK || tail.some((byte) => byte !== 0))
        throw new PublishCleanError("Tarball has an invalid end-of-archive marker.");
      break;
    }
    const type = field(header, TYPE_OFFSET, 1);
    const prefix = field(header, 257, 6) === "ustar" ? field(header, 345, 155) : "";
    const rawName = [prefix, field(header, 0, NAME_LEN)].filter(Boolean).join("/");
    assertChecksum(header, rawName);
    const extended = PAX_TYPES.has(type);
    const name = extended ? rawName : local?.get("path") || rawName;
    let size = entrySize(header);
    const sizeOverride = !extended && local?.get("size");
    if (sizeOverride) {
      if (!/^[0-9]+$/.test(sizeOverride) || !Number.isSafeInteger(Number(sizeOverride)))
        throw new PublishCleanError("Tarball has an invalid PAX size.");
      size = Number(sizeOverride);
    }
    const end = offset + BLOCK + BLOCK * Math.ceil(size / BLOCK);
    if (!Number.isSafeInteger(end) || end > tar.length)
      throw new PublishCleanError(
        `Tarball entry ${JSON.stringify(name)} runs past the end of the archive.`,
      );
    const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    if (type === "L")
      throw new PublishCleanError("Tarball uses GNU long-name entries, which this tool refuses.");
    if (extended) {
      const fields = paxFields(body);
      if (fields.get("path") === MANIFEST_PATH)
        throw new PublishCleanError(
          `Tarball contains a pax header renaming an entry to ${MANIFEST_PATH}.`,
        );
      if (type === "g") {
        // Global path/size overrides make extraction and manifest rewriting ambiguous.
        if (["path", "size", "linkpath"].some((key) => fields.has(key)))
          throw new PublishCleanError("Tarball has a global PAX path, linkpath or size override.");
      } else {
        if (local) throw new PublishCleanError("Tarball has consecutive PAX extended headers.");
        local = fields;
      }
    } else {
      if (name === MANIFEST_PATH) {
        if (type !== "0" && type !== "")
          throw new PublishCleanError(`${MANIFEST_PATH} is not a regular file in the tarball.`);
        if (sizeOverride)
          throw new PublishCleanError(
            "Tarball manifest has a PAX size override that cannot survive rewriting.",
          );
      }
      // Aliased paths can overwrite another entry or escape the package during extraction.
      const parts = name.replace(/\/$/, "").split("/");
      if (
        parts[0] !== "package" ||
        parts.some((part) => !part || part === "." || part === "..") ||
        name.includes("\\") ||
        name.includes("\0")
      )
        throw new PublishCleanError(`Tarball has an unsafe entry path: ${JSON.stringify(name)}.`);
      if (names.has(name))
        throw new PublishCleanError(`Tarball contains ${JSON.stringify(name)} more than once.`);
      names.add(name);
      local = null;
    }
    entries.push({ name, type, header, body, raw: tar.subarray(offset, end) });
    offset = end;
  }
  if (tail === null)
    throw new PublishCleanError("Tarball has no end-of-archive marker; the archive is truncated.");
  if (local) throw new PublishCleanError("Tarball ends with an unused PAX extended header.");
  return { entries, tail };
}

/** Check the final readback against the packed bytes, including entry order and metadata. */
export function assertPreservedArchive(before: TarArchive, after: TarArchive): void {
  if (before.entries.length !== after.entries.length || !before.tail.equals(after.tail))
    throw new PublishCleanError("Rewriting the manifest changed the archive structure.");
  for (const [index, original] of before.entries.entries()) {
    const result = after.entries[index];
    if (
      !result ||
      original.name !== result.name ||
      original.type !== result.type ||
      (original.name === MANIFEST_PATH && !PAX_TYPES.has(original.type)
        ? !reheader(original.header, result.body.length).equals(result.header)
        : !original.raw.equals(result.raw))
    )
      throw new PublishCleanError(
        `Rewriting the manifest changed archive entry ${JSON.stringify(original.name)}.`,
      );
  }
}

/**
 * The paths a consumer's installer writes, with the `package/` prefix stripped — the list every
 * content guard judges. Directories and pax headers are dropped: neither is a file anyone
 * imports, and a pax header's own name (`PaxHeader`) names no file at all.
 */
export function packageFiles(archive: TarArchive): string[] {
  return installedEntries(archive)
    .map((entry) => entry.name)
    .sort();
}

/**
 * The one definition of "a file this package installs". Every guard that judges names and every
 * check that reads bytes must agree about that population, or one of them is judging a different
 * archive than the other believes it is.
 */
function installedEntries(archive: TarArchive): { name: string; body: Buffer }[] {
  return archive.entries
    .filter((entry) => entry.type !== DIRECTORY_TYPE && !PAX_TYPES.has(entry.type))
    .map((entry) => ({
      name: entry.name.startsWith("package/") ? entry.name.slice(8) : entry.name,
      body: entry.body,
    }))
    .filter((entry) => entry.name.length > 0 && !entry.name.endsWith("/"));
}

/**
 * The installed files keyed by name, for the checks that read what a file SAYS rather than only
 * that it is present. The bytes are already in memory — the archive was decompressed once to be
 * read at all — so this costs a map, not a decode.
 *
 * A duplicate name resolves to the last entry, which is what an installer writing entries in
 * order leaves on disk. `packageFiles` keeps every occurrence, so a guard counting names still
 * sees a duplicate this view would hide.
 */
export function packageContents(archive: TarArchive): Map<string, Buffer> {
  return new Map(installedEntries(archive).map((entry) => [entry.name, entry.body]));
}

function manifestEntry(archive: TarArchive): TarEntry {
  // A metadata header's name is only a label, even when it spells package/package.json.
  const entry = archive.entries.find(
    (candidate) => candidate.name === MANIFEST_PATH && !PAX_TYPES.has(candidate.type),
  );
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
  // Compression belongs to the executing runtime; release repair must compare the actual digest.
  return gzipSync(Buffer.concat(parts), { level: 9 });
}
