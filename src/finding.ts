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
 *   hides that it leaked, and the author still has to rotate it. No rule emits it today, because
 *   `validatePackedFiles` refuses that content by throwing instead; the member is that branch
 *   expressed here, not a spare one to delete.
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
 * True when this finding alone must stop the run.
 *
 * Healed findings never stop it: the artifact is correct now, and the message exists so the
 * author can fix the source. `strict` raises the remaining warnings, which is all it does —
 * it cannot promote a healed finding, and it has nothing to add to a rule that is already
 * fatal.
 */
export function isFatal(finding: Finding, strict: boolean): boolean {
  if (finding.healed) return false;
  if (finding.consequence !== "waste") return true;
  return finding.rulesAbort === true || strict;
}

export function decide(findings: readonly Finding[], strict: boolean): boolean {
  return findings.some((finding) => isFatal(finding, strict));
}

/**
 * One block per finding, prefixed so a reader scanning a release log can tell which lines
 * demanded action and which recorded a repair that already happened.
 */
export function formatFindings(findings: readonly Finding[], strict: boolean): string {
  return findings
    .map((finding) => {
      const label = finding.healed ? "healed" : isFatal(finding, strict) ? "error" : "warning";
      return `publish-clean [${label}] ${finding.rule} at ${finding.where}:\n${finding.message}`;
    })
    .join("\n\n");
}
