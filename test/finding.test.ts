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
import { decide, formatFindings, isFatal } from "../src/finding";

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
    expect(decide([], false)).toBe(false);
    expect(decide([harmless, harmless], false)).toBe(false);
    // Position must not matter: a scan that stopped at the first finding would miss the later one.
    expect(decide([harmless, fatal], false)).toBe(true);
    expect(decide([fatal, harmless], false)).toBe(true);
    expect(decide([harmless], true)).toBe(true);
  });

  it("never labels a finding a warning when it is about to stop the run", () => {
    // The label is what a human or an agent acts on, and it is computed separately from the exit.
    // Letting them diverge is the dangerous case: `[warning]` above an aborted publish, or `[error]`
    // above one that proceeds, teaches the reader the opposite of what happened.
    for (const consequence of CONSEQUENCES)
      for (const healed of BOOLEANS)
        for (const rulesAbort of BOOLEANS)
          for (const strict of BOOLEANS) {
            const one = finding({ consequence, healed, rulesAbort });
            const label = formatFindings([one], strict).split(" ")[1];
            expect(label).toBe(
              isFatal(one, strict) ? "[error]" : healed ? "[healed]" : "[warning]",
            );
          }
  });
});
