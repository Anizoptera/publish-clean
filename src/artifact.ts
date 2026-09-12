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
import type { Consequence, Finding } from "./finding";

/**
 * Content that carries a credential. `^` means the package root.
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

/** Build-machine internals. No credential of their own, so the only repair is to stop packing. */
const INTERNAL_PATTERNS = [/(?:^|\/)node_modules(?:\/|$)/i, /(?:^|\/)\.git(?:\/|$)/i];

const SUSPICIOUS_PATTERNS = [
  /(?:^|\/)(?:test|tests|__tests__|__snapshots__|coverage)(?:\/|$)/,
  /(?:^|\/)\.github(?:\/|$)/,
  /(?:^|\/)tsconfig[^/]*\.json$/,
  /(?:^|\/)(?:pnpm-lock\.yaml|bun\.lock|package-lock\.json)$/,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
];

/**
 * Every kind of content the tarball must not carry, in severity order.
 *
 * Order is PRECEDENCE, not presentation: a name matching several rules belongs to the first, so
 * `node_modules/x/.env` is a leaked credential rather than a packed directory. That is the
 * reading whose advice expires if it arrives late.
 *
 * One table rather than three code paths because the three differ only in which names they match
 * and what the author must then do. Judging them alike is what lets one run report all three; a
 * rule that stopped the run at its own hit would hide the two below it.
 */
const PACKED_CONTENT_RULES: readonly {
  readonly rule: string;
  readonly patterns: readonly RegExp[];
  readonly consequence: Consequence;
  /** Fatal despite `waste`; see `Finding.rulesAbort`. Stated per row, never inferred from absence. */
  readonly rulesAbort: boolean;
  /** True only where the judgement is a call an author may overrule. */
  readonly waivable: boolean;
  readonly explain: (files: readonly string[]) => string;
}[] = [
  {
    rule: "secret-file",
    patterns: SECRET_PATTERNS,
    consequence: "harm",
    rulesAbort: false,
    waivable: false,
    explain: (files) =>
      `Treat every file below as a compromised credential and rotate it now. Publishing was ` +
      `never required for that — it was packed, so it already exists outside your repository:\n` +
      `${files.map((file) => `  ${file}`).join("\n")}\n` +
      `This tool will not strip them for you: a stripped secret has still leaked, and an ` +
      `artifact that looks clean is how a leak goes unrotated. Once the credentials are dead, ` +
      `narrow the "files" array in your package.json so the next pack cannot reach them.`,
  },
  {
    rule: "internal-file",
    patterns: INTERNAL_PATTERNS,
    consequence: "harm",
    rulesAbort: false,
    waivable: false,
    explain: (files) =>
      `These belong to the machine that built the package, not to the package:\n` +
      `${files.map((file) => `  ${file}`).join("\n")}\n` +
      `A packed .git carries every committed blob and your remote URLs; a packed node_modules ` +
      `installs a second, unresolvable copy of your dependency tree over the consumer's own. ` +
      `Narrow the "files" array in your package.json.`,
  },
  {
    rule: "suspicious-file",
    patterns: SUSPICIOUS_PATTERNS,
    // Bytes and noise: none of these breaks an install or leaks anything. It still stops the
    // run, because the maintainer ruled shipped waste an error outright, as for
    // `unreferenced-file` — and unlike the two above, that verdict is a judgement call.
    consequence: "waste",
    rulesAbort: true,
    waivable: true,
    explain: (files) =>
      `These are development files rather than anything a consumer installs, so everyone who ` +
      `installs this package downloads them forever for nothing:\n` +
      `${files.map((file) => `  ${file}`).join("\n")}\n` +
      `Remove them from the "files" array in your package.json. If this package ships them on ` +
      `purpose — a test helper other packages import, a tsconfig consumers extend — overrule ` +
      `the judgement with --allow-suspicious, or "publish-clean": { "allowSuspicious": true }.`,
  },
];

/**
 * Reports every kind of content the artifact must not carry, in one pass.
 *
 * Reports rather than throws, including for a leaked key. The refusal is no weaker for it:
 * `isFatal` returns true for any consequence other than `waste` after reading only `healed`, and
 * `harm` is never healed, so no flag reaches this verdict and `--strict` has nothing to add.
 * What it buys is that an author packing a key AND a test tree AND a dead file learns all three
 * in one run — which is the whole reason every other check here returns findings too.
 */
export function reviewPackedContent(files: readonly string[], allowSuspicious: boolean): Finding[] {
  const active = PACKED_CONTENT_RULES.filter((rule) => !rule.waivable || !allowSuspicious);
  const hits = new Map<(typeof active)[number], string[]>();
  for (const file of files) {
    const rule = active.find(({ patterns }) => patterns.some((pattern) => pattern.test(file)));
    if (!rule) continue;
    const matched = hits.get(rule);
    if (matched) matched.push(file);
    else hits.set(rule, [file]);
  }
  // Walks the table rather than the map, so the report reads in severity order however the
  // archive happened to be ordered.
  return active.flatMap((rule) => {
    const matched = hits.get(rule);
    if (!matched) return [];
    return [
      {
        rule: rule.rule,
        consequence: rule.consequence,
        rulesAbort: rule.rulesAbort,
        healed: false,
        where: `${matched.length} packed file(s)`,
        message: rule.explain(matched),
      },
    ];
  });
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
