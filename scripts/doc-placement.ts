#!/usr/bin/env bun
/**
 * Refuses two top-level doc blocks written back to back, which always means one documents nothing.
 *
 * A `/** *\/` block binds to whatever declaration follows it. Insert a documented function directly
 * above an existing one and the anchor lands BELOW that function's doc block, so the block it
 * displaced now sits above the new comment: the newcomer carries two descriptions, the first about
 * a different symbol, and the function that owned it is left bare. Nothing in this repository's
 * gates can see that — the file type-checks, formats and tests identically either way, because the
 * defect is entirely in what a reader is told.
 *
 * That is expensive HERE specifically. This codebase keeps its rulings inline as the artifact, so a
 * displaced block does not merely lose a paragraph: it asserts that paragraph about the wrong
 * symbol. Found three times in one sitting, once on `severityOf`, whose doc states the severity and
 * fatality axes are independent — the ruling most likely to be collapsed by someone who reads the
 * function, finds no reason for it, and tidies it away.
 *
 * Scoped to ADJACENT blocks because that test cannot be wrong: two of them in a row leaves the
 * first documenting a comment, which is never intended. The looser rule — a block must be followed
 * by a declaration — reports every file header above its imports, 33 of them here, and a check
 * firing on correct code is one everybody learns to skip.
 */
import { globSync, readFileSync } from "node:fs";

const offences: string[] = [];
for (const file of globSync(["src/*.ts", "test/*.ts", "scripts/*.ts"]).sort()) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++)
    // Column zero only: an indented block documents a member, and members legitimately sit close.
    if (lines[i] === " */" && lines[i + 1] === "/**")
      offences.push(
        `${file}:${i + 2}: a doc block starts where the previous one ends, so the block above it ` +
          `documents a comment. Move the displaced block back above the function it describes.`,
      );
}

if (offences.length > 0) {
  console.error(offences.join("\n"));
  process.exit(1);
}
