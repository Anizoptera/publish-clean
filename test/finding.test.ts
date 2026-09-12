/**
 * Whether the run stops is the only decision in this tool that cannot be taken back, and it is one
 * pure function over four booleans-worth of input. So the whole space is enumerated: 24 states cost
 * microseconds, and any of them being wrong either burns a version number on a broken package or
 * refuses a correct one.
 *
 * The cases are written as the maintainer's rulings, not as the branches that implement them — a
 * test shaped like the implementation agrees with it by construction, including when both are
 * wrong. Each ruling is quantified over every input the other axes can take, so a branch that
 * happens to be right for the state someone had in mind still fails for the rest.
 */
import { describe, expect, it } from "vitest";

import type { Consequence, Finding } from "../src/finding";
import { formatFindings, isFatal, publishRefusal } from "../src/finding";

const CONSEQUENCES: Consequence[] = ["harm", "breaks", "waste"];
const BOOLEANS = [false, true];

const finding = (part: Partial<Finding>): Finding => ({
  rule: "example",
  consequence: "waste",
  healed: false,
  where: "package.json",
  message: "example",
  ...part,
});

describe.concurrent("whether a finding stops the run", () => {
  it("never stops it for a defect this run already repaired", () => {
    // The artifact being published is correct; the message exists so the author can fix the source.
    // `--strict` raises warnings and must not reach a repair, which is why strict is varied here.
    for (const consequence of CONSEQUENCES)
      for (const rulesAbort of BOOLEANS)
        for (const strict of BOOLEANS)
          expect(isFatal(finding({ healed: true, consequence, rulesAbort }), strict)).toBe(false);
  });

  it("always stops it for an unrepaired leak or breakage", () => {
    // Irreversibility decides, not severity: these ship something to a stranger that cannot be
    // withdrawn. No flag turns them off, so neither axis may change the answer.
    for (const consequence of ["harm", "breaks"] as Consequence[])
      for (const rulesAbort of BOOLEANS)
        for (const strict of BOOLEANS)
          expect(isFatal(finding({ consequence, rulesAbort }), strict)).toBe(true);
  });

  it("stops it for wasted bytes only under --strict", () => {
    // Nothing breaks, so a warning is the whole report unless the author asked for more.
    for (const strict of BOOLEANS)
      expect(isFatal(finding({ consequence: "waste" }), strict)).toBe(strict);
  });

  it("stops it for the one waste rule that carries its own verdict", () => {
    // A shipped file nothing reaches was ruled an error outright. It is carried as data on the
    // finding so the divergence stays visible, which means it must hold without `--strict` too.
    for (const strict of BOOLEANS)
      expect(isFatal(finding({ consequence: "waste", rulesAbort: true }), strict)).toBe(true);
  });
});

describe.concurrent("the verdict a report hands to its reader", () => {
  it("stops the run when any single finding demands it, and not otherwise", () => {
    const harmless = finding({ consequence: "waste" });
    const fatal = finding({ consequence: "breaks" });
    expect(publishRefusal([], false)).toBeNull();
    expect(publishRefusal([harmless, harmless], false)).toBeNull();
    // Position must not matter: a scan that stopped at the first finding would miss the later one.
    expect(publishRefusal([harmless, fatal], false)).toContain("1 unrepaired");
    expect(publishRefusal([fatal, harmless], false)).toContain("1 unrepaired");
    expect(publishRefusal([harmless], true)).toContain("1 unrepaired");
  });

  it("counts the findings that stopped the run, not the findings it printed", () => {
    // The number is a claim the reader checks against the blocks above it. Counting everything
    // reported — repairs and warnings included — turns a correct report into one that says three
    // things would reach consumers when one would, and the author hunts two defects that are fine.
    const report = publishRefusal(
      [
        finding({ consequence: "breaks", healed: true }),
        finding({ consequence: "waste" }),
        finding({ consequence: "harm" }),
      ],
      false,
    );
    expect(report).toContain("1 unrepaired");
  });

  // How bad a defect is and what this run did about it are independent, and the report prints
  // them as independent words. Collapsing them is what makes a reader skim: a repaired breakage
  // shown as its own gentle category reads like a harmless stray file, and the source defect
  // survives every release while each release looks clean.
  it("does not soften a defect because this run repaired the artifact", () => {
    for (const healed of BOOLEANS)
      for (const rulesAbort of BOOLEANS)
        for (const strict of BOOLEANS)
          for (const consequence of ["harm", "breaks"] as Consequence[])
            expect(
              formatFindings([finding({ consequence, healed, rulesAbort })], strict),
            ).toContain("[error]");
  });

  it("calls wasted bytes a warning until someone rules otherwise", () => {
    // The two ways it stops being a warning are the maintainer's own: the rule carries its verdict
    // as data, or the author asked for more with `--strict`. Healing changes neither.
    for (const healed of BOOLEANS) {
      expect(formatFindings([finding({ consequence: "waste", healed })], false)).toContain(
        "[warning]",
      );
      expect(formatFindings([finding({ consequence: "waste", healed })], true)).toContain(
        "[error]",
      );
      expect(
        formatFindings([finding({ consequence: "waste", healed, rulesAbort: true })], false),
      ).toContain("[error]");
    }
  });

  it("says a repair happened, and says it only when one did", () => {
    // The severity word alone no longer carries this, so the sentence has to. Without it an author
    // reading `[error]` above a repaired finding re-releases to fix an artifact already correct —
    // and with it stated loosely they would believe their SOURCE was fixed, which it never is.
    const repaired = "repaired in the published artifact, not in your source";
    for (const consequence of CONSEQUENCES)
      for (const strict of BOOLEANS) {
        expect(formatFindings([finding({ consequence, healed: true })], strict)).toContain(
          repaired,
        );
        expect(formatFindings([finding({ consequence })], strict)).not.toContain("repaired");
      }
  });

  it("never shows a warning above a run it is about to stop", () => {
    // The severity is what a human or an agent acts on. `[warning]` above an aborted publish
    // teaches the reader the opposite of what happened.
    for (const consequence of CONSEQUENCES)
      for (const healed of BOOLEANS)
        for (const rulesAbort of BOOLEANS)
          for (const strict of BOOLEANS) {
            const one = finding({ consequence, healed, rulesAbort });
            if (isFatal(one, strict)) expect(formatFindings([one], strict)).toContain("[error]");
          }
  });
});
