/**
 * What the published tarball may CARRY. Every rule here judges a file list — the archive's entry
 * paths with the `package/` prefix already stripped — never a directory on disk, because that
 * list is what a consumer's installer unpacks and it needs no filesystem to exist.
 *
 * The opposite question — whether everything the manifest declares is IN that list — is
 * `declared.ts`. Nothing here reads the manifest, which is why these rules need no parsing and
 * cost a pass over names.
 *
 * Ambient inputs arrive as parameters and never by reaching for them — no process, filesystem or
 * argv here. `cli.ts` owns the effects.
 */
import { PublishCleanError } from "./error";
import type { Finding } from "./finding";

/**
 * Content that carries a credential. `^` means the package root.
 *
 * Split from the merely-internal patterns below because the two need OPPOSITE advice, and a
 * message giving one of them the other's is worse than a generic one: a secret needs rotating
 * whatever you do to the tarball, and telling its owner only to fix `files` reads as a repair
 * that does not exist. Nothing here is ever stripped for the author — a stripped secret has
 * still leaked, and removing it from the artifact is how it goes unrotated.
 *
 * Case-insensitive throughout, because the filesystems most packages are built on are
 * too. On macOS and Windows `Server.PEM` and `server.pem` are the same file, so a
 * case-sensitive guard refuses one and publishes the other, which is worse than no guard:
 * it reads as coverage.
 *
 * Private keys are matched by extension and, separately, by exact filename. SSH keys carry
 * no extension at all, and `id_rsa` is the most common private-key filename there is. The
 * exact-name form deliberately does not match `id_rsa.pub`, which is public by design and
 * legitimate to ship.
 */
const SECRET_PATTERNS = [
  /(?:^|\/)\.env(?:\.|$)/i,
  /(?:^|\/)\.npmrc$/i,
  /\.(?:pem|key|p12|pfx|p8|ppk|jks|keystore)$/i,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i,
];

/**
 * Build-machine internals. Nothing to rotate — they carry no credential of their own — so the
 * only repair is to stop packing them, which is why they are judged apart from the secrets.
 */
const INTERNAL_PATTERNS = [/(?:^|\/)node_modules(?:\/|$)/i, /(?:^|\/)\.git(?:\/|$)/i];

const SUSPICIOUS_PATTERNS = [
  /(?:^|\/)(?:test|tests|__tests__|__snapshots__|coverage)(?:\/|$)/,
  /(?:^|\/)\.github(?:\/|$)/,
  /(?:^|\/)tsconfig[^/]*\.json$/,
  /(?:^|\/)(?:pnpm-lock\.yaml|bun\.lock|package-lock\.json)$/,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
];

/**
 * Judges the packed file list in two halves that must not be merged.
 *
 * A `suspicious` hit is a judgement call — hence `--allow-suspicious` — so it reports like every
 * other defect in the package being examined, and the run continues to collect the rest. It still
 * refuses to publish, through `rulesAbort`.
 *
 * A `critical` hit THROWS instead, which ends the run at the offender: nothing after this line
 * decides whether a leaked key reaches a registry, and nothing after it gets to report either. The
 * cost of that is a leaked key arriving alone, without whatever else the same package is doing
 * wrong. `Consequence` reserves `harm` for exactly this content — a secret, `node_modules`, Git
 * internals — and this throw is why nothing emits it; that member is not dead, it is this branch
 * written in the other model.
 */
export function validatePackedFiles(files: readonly string[], skipSuspicious: boolean): Finding[] {
  // One pass, and secrets win a name matching both — `node_modules/x/.env` is a leaked
  // credential first and a packed directory second, and the rotation instruction is the half
  // that expires if it arrives late.
  const secrets: string[] = [];
  const internals: string[] = [];
  for (const file of files) {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(file))) secrets.push(file);
    else if (INTERNAL_PATTERNS.some((pattern) => pattern.test(file))) internals.push(file);
  }
  const critical = [...secrets, ...internals];
  if (critical.length > 0)
    throw new PublishCleanError(
      `Critical files must not be published:\n${critical.map((file) => JSON.stringify(file)).join("\n")}\n` +
        (secrets.length > 0
          ? `Treat every credential above as compromised and rotate it now. Publishing was not ` +
            `required for that — it was packed, so it exists outside your repository already. ` +
            `This tool will not strip them for you: a stripped secret has still leaked, and an ` +
            `artifact that looks clean is how it goes unrotated.\n`
          : "") +
        `Then narrow the "files" array in your package.json so the next pack cannot reach them.`,
    );
  if (skipSuspicious) return [];

  const suspicious = files.filter((file) =>
    SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(file)),
  );
  if (suspicious.length === 0) return [];
  return [
    {
      rule: "suspicious-file",
      // Bytes and noise: none of these breaks an install or leaks anything — a leak is the
      // `critical` half above, which throws. It still stops the run, because the maintainer
      // ruled shipped waste an error outright, exactly as for `unreferenced-file`.
      consequence: "waste",
      rulesAbort: true,
      healed: false,
      where: `${suspicious.length} files`,
      message:
        `These are development files rather than anything a consumer installs, so everyone who ` +
        `installs this package downloads them forever for nothing:\n` +
        `${suspicious.map((file) => `  ${file}`).join("\n")}\n` +
        `Remove them from the "files" array in your package.json. If this package ships them on ` +
        `purpose — a test helper other packages import, a tsconfig consumers extend — overrule ` +
        `the judgement with --allow-suspicious, or "publish-clean": { "allowSuspicious": true }.`,
    },
  ];
}

/**
 * Refuses a rewritten tarball whose file set is not the packed one, entry for entry.
 *
 * Replacing a member is supposed to change one member, and the rewriter copies every other
 * entry as opaque bytes — so this can only fail through a defect in that code, which is exactly
 * why it is worth asserting on the step that cannot be taken back. Nothing else would notice a
 * dropped file: the leak checks only ask what is present, and a package missing a file installs
 * fine and then fails at import, on a version the registry keeps forever.
 *
 * The two lists come from the same reader, so this cannot catch a defect in the reader itself —
 * only one in the rewrite, which is what it is for. Independence from the reader is bought
 * elsewhere, by the case in test/cli.test.ts that compares the list this reader prints against
 * `tar tzf` of the same tarball — an instrument that cannot share a mistake with this one.
 */
export function assertSameEntries(packed: readonly string[], published: readonly string[]): void {
  const before = new Set(packed);
  const after = new Set(published);
  const changed = [
    ...packed.filter((file) => !after.has(file)).map((file) => `- ${file}`),
    ...published.filter((file) => !before.has(file)).map((file) => `+ ${file}`),
  ];
  if (changed.length > 0)
    throw new PublishCleanError(
      `Rewriting the tarball manifest changed its file set:\n${changed.join("\n")}`,
    );
}
