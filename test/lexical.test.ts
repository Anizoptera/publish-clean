/**
 * The scanner decides whether a specifier is an import this file PERFORMS or characters it merely
 * contains, and two rules act on that answer — one of which aborts a publish. So the case that
 * matters is not a missed import but a mis-called one: text reported as code fabricates a refusal
 * of a correct package, and a published version cannot be taken back.
 *
 * Nesting is enumerated rather than hand-picked. Every construct here was already handled in
 * isolation while `` `a${`b`}c` `` — a template inside a template — silently reported its inner
 * TEXT as running code, because the combination is what breaks, and a table holds only the
 * combinations its author thought of.
 *
 * `new Function` is the independent oracle: it proves each generated fixture is really JavaScript,
 * so a case cannot pass by asserting about a string no engine would accept.
 */
import { describe, expect, it } from "vitest";

import { lexicalZones, zoneAt } from "../src/lexical";

const MARKER = "MARKER";
const BACKTICK = String.fromCharCode(96);
const OPEN = "${";

/** An expression whose inside the runtime hides — or, for `code`, does not hide at all. */
const TERMINALS = {
  code: { build: (inner: string) => inner, zone: "code" },
  single: { build: (inner: string) => `'x ${inner} y'`, zone: "text" },
  double: { build: (inner: string) => `"x ${inner} y"`, zone: "text" },
  template: { build: (inner: string) => `${BACKTICK}x ${inner} y${BACKTICK}`, zone: "text" },
  block: { build: (inner: string) => `/* x ${inner} y */ 0`, zone: "comment" },
  line: { build: (inner: string) => `// x ${inner} y\n0`, zone: "comment" },
} as const;

/** One `${…}` level. Only interpolation returns to code, which is what makes nesting reachable. */
const interpolate = (inner: string) => `${BACKTICK}pre${OPEN} ${inner} }post${BACKTICK}`;

describe.concurrent("where each byte of a source file sits", () => {
  for (const [name, terminal] of Object.entries(TERMINALS))
    for (const depth of [0, 1, 2, 3]) {
      it(`reads ${name} through ${depth} interpolation(s)`, () => {
        let source = terminal.build(MARKER);
        for (let level = 0; level < depth; level++) source = interpolate(source);

        // Proves the fixture is JavaScript before anything is claimed about how it reads.
        expect(() => new Function(source)).not.toThrow();

        const zones = lexicalZones(source);
        expect(zones).not.toBeNull();
        expect(zoneAt(zones as Uint8Array, source.indexOf(MARKER))).toBe(terminal.zone);
      });
    }

  it("refuses to answer from a position it cannot trust", () => {
    // Every finding built on this scanner is suppressed when it returns null, so these are the
    // inputs where a WRONG answer would be worse than none. Each is invalid JavaScript, which is
    // what makes an open state at the end of the file a sound signal that the scan lost its place.
    for (const source of [
      `const s = 'unterminated`,
      `const s = "unterminated`,
      `const s = ${BACKTICK}unterminated`,
      `/* unterminated`,
      `const a = ${BACKTICK}pre${OPEN} 1`,
      `const a = ${BACKTICK}pre${OPEN} 1 }`,
    ]) {
      expect(() => new Function(source)).toThrow();
      expect(lexicalZones(source)).toBeNull();
    }
  });

  it("treats a line comment reaching the end of the file as valid", () => {
    // Valid JavaScript, so dropping the file here would lose real findings for no reason.
    expect(lexicalZones(`const a = 1; // trailing`)).not.toBeNull();
  });

  it("keeps an interpolation open across braces of its own", () => {
    // An object literal inside an interpolation is ordinary, and closing at the first `}` it meets
    // shifts every later zone. The marker sits AFTER that brace and still inside the expression —
    // the only region the two readings disagree about, since a marker before it or in the trailing
    // template text reads the same either way and would assert nothing.
    const source = `const a = ${BACKTICK}pre${OPEN} f({ k: 1 }) + ${MARKER} }post${BACKTICK};`;
    expect(() => new Function(source)).not.toThrow();
    const zones = lexicalZones(source);
    expect(zones).not.toBeNull();
    expect(zoneAt(zones as Uint8Array, source.indexOf(MARKER))).toBe("code");
  });

  it("does not interpolate inside a quoted string", () => {
    // `${` is structural only in a template. Treating it as an opener in a quoted string would put
    // the scanner into code inside text — the direction that fabricates refusals.
    const source = `const a = "pre${OPEN} ${MARKER} }post";`;
    expect(() => new Function(source)).not.toThrow();
    const zones = lexicalZones(source);
    expect(zoneAt(zones as Uint8Array, source.indexOf(MARKER))).toBe("text");
  });

  it("keeps an escaped quote from ending its string", () => {
    const source = `const a = 'it\\'s ${MARKER}'; const b = 1;`;
    expect(() => new Function(source)).not.toThrow();
    const zones = lexicalZones(source);
    expect(zoneAt(zones as Uint8Array, source.indexOf(MARKER))).toBe("text");
  });
});
