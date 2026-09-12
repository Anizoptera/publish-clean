/**
 * What a check reports, and whether the run may continue.
 *
 * Every other guard in this tool throws, because its answer is always "stop". These checks
 * cannot: some of them repair what they find, and a repaired defect must not stop a publish
 * that is now correct. So they return records and one pure function decides the exit.
 *
 * Returned rather than printed, for the reason `unrecognizedFieldsReport` is: a message that is
 * a value can be asserted whole, where a message written to a process-wide `console` can be
 * clobbered by a case running beside it.
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
  /** Stable identifier, so a message can be silenced or searched without quoting its prose. */
  readonly rule: string;
  readonly consequence: Consequence;
  /** True when this run already repaired it in the artifact being published. */
  readonly healed: boolean;
  /** Where in the manifest or archive, e.g. `exports["."]` or `dist/index.js`. */
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
export type Severity = "error" | "warning";

export function severityOf(finding: Finding, strict: boolean): Severity {
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

export function decide(findings: readonly Finding[], strict: boolean): boolean {
  return findings.some((finding) => isFatal(finding, strict));
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
