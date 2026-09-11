/**
 * Where in a source file each byte sits: running code, a comment, or the inside of a string.
 *
 * A checker that asks "does this file import X" has to know which, and the question is lexical
 * rather than line-shaped. Three real cases decide it, each measured in a published package:
 * `{import("pkg/sub").T}` in a JSDoc block is a type a checker RESOLVES, so comments cannot be
 * discarded; a prose example of an import in that same block resolves nothing; and an import
 * written into a template literal is code this file GENERATES for somebody else's project.
 * Line-prefix tests answer all three wrongly as soon as a comment wraps or a template spans lines.
 *
 * This is a scanner, not a parser: it tracks only the states that hide text from the runtime, which
 * is all the callers ask about. Ambient inputs arrive as parameters.
 */

export type Zone = "code" | "comment" | "text";

const CODE = 0;
const COMMENT = 1;
const TEXT = 2;
const ZONES: readonly Zone[] = ["code", "comment", "text"];

/**
 * One byte per source byte, or `null` when the scan ends somewhere a valid file cannot end.
 *
 * The `null` is the instrument admitting it lost track. A regular expression literal may hold an
 * apostrophe (`/it's/`), and telling one from a division needs the grammar this scanner does not
 * have, so a desync is possible — and it shows up as a string or block comment still open at the
 * end of a file, which valid JavaScript cannot do. Callers drop the whole file rather than report
 * from a position they cannot trust: a missed defect costs less than a refused publish.
 *
 * A line comment IS allowed to reach the end of a file, so it does not count as a desync.
 *
 * Measured over 3051 shipped `.js`/`.ts` files in installed packages: 1.8% desync, but 11.3% of
 * BYTES, because the losses concentrate in large bundles — this tool's own `dist/cli.js` is one.
 * Teaching the scanner to tell a regex from a division would recover them and is deliberately NOT
 * done: at 1.8% of files the loss only ever SUPPRESSES a report, while a wrong guess about where a
 * regex ends shifts string parity and can mark text as code, which is how a correct package gets
 * refused. A smaller safe gap is not worth a larger unsafe one.
 */
export function lexicalZones(source: string): Uint8Array | null {
  const zones = new Uint8Array(source.length);
  /**
   * Brace depth inside each open `${…}`, innermost last; empty means no interpolation is open.
   *
   * Template interpolation is the one construct that UNHIDES text, so a scanner defined by what
   * hides text cannot skip it. Without this a template's inner backtick reads as the outer
   * template's terminator, and everything after it shifts zone: text becomes code and code becomes
   * text, with the parity restored by the closing backtick so nothing ever reports a desync. That
   * is the dangerous direction — a generated import sitting in a NESTED template is handed to the
   * self-import scan as running code, which aborts a publish that was correct. Code generators are
   * exactly the packages that nest templates, and exactly the ones that write imports into them.
   *
   * The depth is needed because an interpolation ends at its OWN closing brace, and an object
   * literal or block inside it carries braces of its own.
   */
  const interpolations: number[] = [];
  let state = CODE;
  let quote = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (state === CODE) {
      if (char === "/" && next === "/") {
        zones[index] = COMMENT;
        zones[index + 1] = COMMENT;
        index += 2;
        state = COMMENT;
        quote = "\n";
        continue;
      }
      if (char === "/" && next === "*") {
        zones[index] = COMMENT;
        zones[index + 1] = COMMENT;
        index += 2;
        state = COMMENT;
        quote = "*/";
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        zones[index] = TEXT;
        index += 1;
        state = TEXT;
        quote = char;
        continue;
      }
      const open = interpolations.length - 1;
      if (open >= 0 && (char === "{" || char === "}")) {
        const depth = interpolations[open] ?? 0;
        // The brace that closes the interpolation hands the rest of the line back to the template.
        if (char === "}" && depth === 0) {
          interpolations.pop();
          zones[index] = TEXT;
          index += 1;
          state = TEXT;
          quote = "`";
          continue;
        }
        interpolations[open] = char === "{" ? depth + 1 : depth - 1;
      }
      zones[index] = CODE;
      index += 1;
      continue;
    }

    zones[index] = state === COMMENT ? COMMENT : TEXT;
    if (state === TEXT) {
      // An escape hides the character after it, including a closing quote.
      if (char === "\\") {
        zones[index + 1] = TEXT;
        index += 2;
        continue;
      }
      // Only a template interpolates; `${` is ordinary text in a quoted string.
      if (quote === "`" && char === "$" && next === "{") {
        zones[index + 1] = TEXT;
        interpolations.push(0);
        index += 2;
        state = CODE;
        continue;
      }
      if (char === quote) state = CODE;
      index += 1;
      continue;
    }
    if (quote === "\n" && char === "\n") state = CODE;
    else if (quote === "*/" && char === "*" && next === "/") {
      zones[index + 1] = COMMENT;
      index += 2;
      state = CODE;
      continue;
    }
    index += 1;
  }
  // An open interpolation at the end of a file means an unterminated template, whatever state the
  // scan stopped in — including a line comment, which is otherwise allowed to run to the end.
  if (interpolations.length > 0) return null;
  return state === CODE || (state === COMMENT && quote === "\n") ? zones : null;
}

export function zoneAt(zones: Uint8Array, index: number): Zone {
  return ZONES[zones[index] ?? CODE] ?? "code";
}
