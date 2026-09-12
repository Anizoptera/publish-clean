/**
 * What a check reports, and whether the run may continue.
 *
 * Every other guard in this tool throws, because its answer is always "stop". These checks
 * cannot: some of them repair what they find, and a repaired defect must not stop a publish
 * that is now correct. So they return records and one pure function decides the exit.
 *
 * Returned rather than printed: a message that is a value can be asserted whole, where one written
 * to a process-wide `console` can be clobbered by a case running beside it. Everything a run has
 * to say about the package travels this way, so the report has ONE shape — a rule id to grep, a
 * severity to rank by, a location. A check that printed its own paragraph instead
 * would land wherever in the output it happened to run, unrankable and unsearchable.
 *
 * Ambient inputs arrive as parameters — no process, filesystem or argv here.
 */

/**
 * What happens to somebody else if this ships. It decides the exit, and severity does not:
 * publishing burns a version number forever, so blocking a good publish costs the author a
 * re-run while shipping a broken one costs a release nobody can take back.
 *
 * - `harm` — a secret, `node_modules`, Git internals. NEVER healed: stripping a leaked token
 *   hides that it leaked, and the author still has to rotate it. Nothing waives it: `isFatal`
 *   reads only `healed` for a consequence other than `waste`, so no flag reaches this verdict.
 * - `breaks` — a consumer's build fails or silently gets the wrong file.
 * - `waste` — bytes or noise; nothing breaks.
 */
export type Consequence = "breaks" | "harm" | "waste";

export interface Finding {
  /**
   * Stable identifier, so a report can be searched or diffed without quoting its prose. It is not
   * a silencing key: a rule that may be waived carries its own hatch and names it in the message
   * (`--allow-suspicious`, `allowUnreferenced`), because waiving one judgement must never be
   * spelled the same as waiving another.
   */
  readonly rule: string;
  readonly consequence: Consequence;
  /** True when this run already repaired it in the artifact being published. */
  readonly healed: boolean;
  /**
   * Where in the manifest or archive, e.g. `exports["."]` or `dist/index.js` — or, for a rule that
   * judges a whole set at once, how big that set is (`12 packed file(s)`). A rule matching fifty
   * files has no single location, and putting fifty paths on the header line buries the severity
   * and the rule id that the reader scans for; the message below carries the list. Pick the count
   * form only when the rule really is set-shaped, never to avoid naming a location it knows.
   * Build that form with `countOf`, so one rule cannot say "1 files" while its neighbour says
   * "1 file(s)".
   */
  readonly where: string;
  /**
   * The whole message, including the exact text that resolves it — the config line to paste,
   * the reordered block, the `files` entry to add. An out-of-context reader must be able to
   * act on it without opening any documentation.
   */
  readonly message: string;
  /**
   * Fatal despite being `waste`. Set by the rules the maintainer ruled an error outright even
   * though nothing breaks — shipped bytes no consumer asked for. Carried as data so each
   * divergence from the consequence model is visible in the findings table rather than hidden
   * in a branch on a rule id that someone deletes while tidying.
   */
  readonly rulesAbort?: boolean;
}

/**
 * How bad the defect is — and nothing else. Repairing one does not make it milder: the defect is
 * still in the author's source, and only the published artifact was corrected. Keeping severity
 * independent of what this run did is what stops a repaired breakage from printing as a warning
 * and teaching the reader to skim it.
 */
/**
 * `3 files`, `1 file` — the count phrase every set-shaped rule needs, written once.
 *
 * Six rules were building this inline and disagreeing: two printed `1 file(s)`, three printed
 * `1 files`. `(s)` is a note to the reader that the writer could not be bothered with the case
 * that happens most — a report naming one bad file — and this tool's whole claim is care about
 * what ships. Every noun these rules use takes a plain `s`; give the irregular one an explicit
 * plural the day it exists, not before.
 */
export function countOf(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}

type Severity = "error" | "warning";

function severityOf(finding: Finding, strict: boolean): Severity {
  if (finding.consequence !== "waste") return "error";
  return finding.rulesAbort === true || strict ? "error" : "warning";
}

/**
 * Whether this finding alone stops the run — the other axis, and the only irreversible one.
 *
 * A repair never stops it: the artifact being published is correct now. Everything else that is
 * error-severity does, because this tool cannot clean it and a published version is burned
 * forever. Reported first and decided at the end, so a run that stops still shows everything it
 * found rather than the first thing it met.
 */
export function isFatal(finding: Finding, strict: boolean): boolean {
  return !finding.healed && severityOf(finding, strict) === "error";
}

/**
 * Why this publish must not proceed, or null when it may.
 *
 * The verdict and the count come from one pass, so a report cannot announce a number of findings
 * that differs from the set that actually stopped the run — two expressions of the same predicate
 * is how that drifts.
 *
 * `null | string` is this program's single way of saying "refused, and here is why": the checks
 * that run before anything is packed answer in the same shape (`privatePackageRefusal` and its
 * siblings in `manifest.ts`), so every refusal reads alike instead of a boolean in one place and a
 * message in another.
 */
export function publishRefusal(findings: readonly Finding[], strict: boolean): null | string {
  const fatal = findings.filter((finding) => isFatal(finding, strict));
  return fatal.length === 0
    ? null
    : `Refusing to publish: ${countOf(fatal.length, "unrepaired finding")} above would reach consumers. ` +
        `A published version cannot be taken back.`;
}

/**
 * One block per finding: how bad it is, then separately whether this run already fixed it.
 *
 * The two were one word before, with a repair printing as its own gentle category — so a repaired
 * breakage and a harmless stray file read alike, and the reader learned to skim both. They are
 * independent facts and print as independent words.
 */
export function formatFindings(findings: readonly Finding[], strict: boolean): string {
  return findings
    .map((finding) => {
      const repaired = finding.healed
        ? " repaired in the published artifact, not in your source:"
        : "";
      return `publish-clean [${severityOf(finding, strict)}] ${finding.rule} at ${finding.where}${repaired}\n${finding.message}`;
    })
    .join("\n\n");
}
