/**
 * Replaces the manifest inside a packed tarball without repacking it.
 *
 * The pipeline packs once, with pnpm, because that packer decides the file set. Cleaning the
 * manifest by unpacking and packing again hands that decision to a second packer, which
 * re-derives it from the very field being cleaned and silently disagrees; rewriting the one
 * member that changed keeps the first packer's selection, and its normalisation (uid/gid 0,
 * a fixed mtime, mode 644) that a naive `tar` invocation leaks the build machine's identity
 * into.
 *
 * Every entry other than the manifest is copied as opaque bytes and never decoded, so entry
 * shapes this code does not model — pax extended headers, ustar prefix splitting, GNU long
 * names — survive untouched. Only walking is universal: an entry's length is always its
 * header block plus its size rounded up to a block, whatever the type.
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
 * Returns the gzipped tarball with `package/package.json` replaced by `manifest`.
 *
 * Refuses anything it cannot rewrite unambiguously. Duplicate manifest entries are a refusal
 * rather than a last-one-wins guess, because extractors disagree about which survives and the
 * published manifest would then depend on the extractor rather than on this tool.
 */
export function replaceTarballManifest(archive: Buffer, manifest: string): Buffer {
  const tar = gunzipSync(archive);
  const parts: Buffer[] = [];
  let replaced = false;

  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK);
    const name = field(header, 0, NAME_LEN);
    if (name === "") {
      // Zero block: the end-of-archive marker and its padding, kept byte for byte.
      parts.push(tar.subarray(offset));
      break;
    }
    const size = entrySize(header);
    const end = offset + BLOCK + BLOCK * Math.ceil(size / BLOCK);
    const type = field(header, TYPE_OFFSET, 1);

    if (type === GNU_LONG_NAME)
      throw new PublishCleanError("Tarball uses GNU long-name entries, which this tool refuses.");
    if (PAX_TYPES.has(type))
      assertNoManifestOverride(tar.subarray(offset + BLOCK, offset + BLOCK + size));

    if (name === MANIFEST_PATH) {
      if (replaced)
        throw new PublishCleanError(`Tarball contains ${MANIFEST_PATH} more than once.`);
      if (type !== "0" && type !== "")
        throw new PublishCleanError(`${MANIFEST_PATH} is not a regular file in the tarball.`);
      const body = Buffer.from(manifest, "utf8");
      parts.push(
        reheader(header, body.length),
        body,
        Buffer.alloc(BLOCK * Math.ceil(body.length / BLOCK) - body.length),
      );
      replaced = true;
    } else parts.push(tar.subarray(offset, end));

    offset = end;
  }

  if (!replaced) throw new PublishCleanError(`Tarball does not contain ${MANIFEST_PATH}.`);
  return gzipSync(Buffer.concat(parts));
}
