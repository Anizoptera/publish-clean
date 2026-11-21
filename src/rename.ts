/**
 * Decides which `renameFiles` entries the rewrite applies, and reports the rest.
 *
 * Every refusal here is `breaks`: the author named a file consumers must find under a new name, so
 * an entry that cannot be applied ships a package missing that file — or, for an occupied target,
 * ships two files where the author meant one. Nothing is renamed on a guess: an entry that fails is
 * left out of the rewrite entirely, so the archive still carries pnpm's name for that file and the
 * report says why.
 */
import type { Finding } from "./finding";
import { packageFiles, renameRefusal } from "./tarball";
import type { RenameRefusal, TarArchive } from "./tarball";

const UNSUPPORTED: Record<Exclude<RenameRefusal, "missing">, string> = {
  "not-file": "it is not a regular file in the archive, and only file names are renamed",
  "extended-name":
    "pnpm stored its name in an extended (long-name) header, which this tool does not rewrite; shorten the source path",
  "too-long":
    "the new name does not fit a tar header (100 bytes, or 155 + 100 split at a /); shorten the target path",
};

export function reviewRenames(
  archive: TarArchive,
  renames: ReadonlyMap<string, string>,
): { applied: Map<string, string>; findings: Finding[] } {
  const applied = new Map<string, string>();
  const findings: Finding[] = [];
  if (renames.size === 0) return { applied, findings };
  const packed = packageFiles(archive);
  for (const [source, target] of renames) {
    const where = `publish-clean.renameFiles[${JSON.stringify(source)}]`;
    const refusal = renameRefusal(archive, source, target);
    if (refusal === "missing") {
      findings.push({
        rule: "rename-source-missing",
        consequence: "breaks",
        healed: false,
        where,
        message:
          `${source} is not in the packed archive, so nothing ships as ${target}. pnpm still decides ` +
          `which files are packed: add ${source} to the "files" array in your package.json, or fix ` +
          `the path (it is relative to the package root, as pnpm packs it).`,
      });
      continue;
    }
    // Judged against pnpm's names, not the renamed set: a target that is another rename's source
    // is refused with the configuration, so these are files that ship under their own name.
    const occupied = packed.filter(
      (file) => file === target || file.startsWith(`${target}/`) || target.startsWith(`${file}/`),
    );
    if (occupied.length > 0) {
      findings.push({
        rule: "rename-target-exists",
        consequence: "breaks",
        healed: false,
        where,
        message:
          `${source} cannot ship as ${target}: the packed archive already carries ` +
          `${occupied.join(", ")}, and two members claiming one path leave the installed file to ` +
          `whichever the extractor writes last. Stop packing the existing file — remove it from ` +
          `"files" or exclude it with a "!" entry — or choose another target.`,
      });
      continue;
    }
    if (refusal !== null) {
      findings.push({
        rule: "rename-unsupported",
        consequence: "breaks",
        healed: false,
        where,
        message: `${source} cannot ship as ${target}: ${UNSUPPORTED[refusal]}.`,
      });
      continue;
    }
    applied.set(source, target);
  }
  return { applied, findings };
}
