/**
 * Every rule here judges a file list, so a case costs microseconds and the evasions that matter
 * are all affordable. The end-to-end suite proves the CLI reaches these and that a real packer
 * emits the paths they judge; what it cannot afford is breadth, so the matrices live here.
 */
import { describe, expect, it } from "vitest";

import { reviewPackedContent } from "../src/artifact";
import { isFatal } from "../src/finding";

/** Every assertion here pins the verdict, never the wording: `--strict` off is the weakest case. */
const refuses = (files: string[], allowSuspicious = false): boolean =>
  reviewPackedContent(files, allowSuspicious).some((finding) => isFatal(finding, false));

describe.concurrent("critical file patterns", () => {
  // The package's headline promise is that a private key cannot reach the registry, so the
  // ways a key file evades a pattern are the failures that matter most. An SSH key carries no
  // extension at all, and on the case-insensitive filesystems most packages are built on
  // `Server.PEM` is the same file as `server.pem`.
  const secrets = [
    "id_rsa",
    "id_dsa",
    "deploy/id_ed25519",
    "Server.PEM",
    "certs/private.Key",
    ".env",
    "config/deploy.key",
    ".git/config",
    "node_modules/left-pad/index.js",
  ];

  for (const secret of secrets) {
    it(`refuses to publish ${secret}`, () => {
      expect(refuses(["index.js", secret])).toBe(true);
    });
  }

  // A guard that stopped at the first offender passed every single-file case above, and an
  // author who deletes the one name it printed would publish the rest.
  it("names every offender at once, not just the first", () => {
    const report = reviewPackedContent(["index.js", ...secrets], false)
      .map((finding) => finding.message)
      .join("\n");
    for (const secret of secrets) expect(report).toContain(secret);
  });

  // The one waiver this tool has must not reach content nobody may waive. `--allow-suspicious`
  // is a judgement about development files; an author setting it is not consenting to publish a
  // key, and a shared opt-out is how they would.
  it("keeps refusing them when the suspicious-file judgement is waived", () => {
    expect(refuses(["index.js", ".env"], true)).toBe(true);
  });

  // The refusal is the cheap half. A packed key is already outside the author's repository, so
  // the only repair that still works is rotation — and an author told merely to fix `files`
  // reads that as the whole fix and leaves a live credential in a tarball on a build machine.
  // The control is the same refusal over content that carries no credential: advising rotation
  // there is noise that teaches readers to skim the paragraph that matters.
  it("says to rotate a packed credential, and says it only for credentials", () => {
    const [key] = reviewPackedContent(["index.js", "deploy/id_ed25519"], false);
    expect(key?.message).toMatch(/rotate/i);
    const [internals] = reviewPackedContent(["index.js", "node_modules/left-pad/index.js"], false);
    expect(internals?.message).toMatch(/files/);
    expect(internals?.message).not.toMatch(/rotate/i);
  });

  // A name matching both must take the reading whose advice expires: the author has to rotate
  // the key whatever they do to the tarball, and a run that filed it under the packed directory
  // would tell them only to fix `files`.
  it("reads a credential inside a packed directory as the credential", () => {
    const [finding] = reviewPackedContent(["index.js", "node_modules/pkg/.npmrc"], false);
    expect(finding?.rule).toBe("secret-file");
  });

  it("passes a package that carries none of them", () => {
    expect(
      reviewPackedContent(["index.js", "index.d.ts", "README.md", "src/env.js"], false),
    ).toEqual([]);
  });
});

// The default hygiene check, and the one an author meets most often: a package shipping its own
// test tree or lockfile cannot publish until someone decides. The assertions below pin BOTH
// halves — that it reports, and that it still refuses — because a finding that quietly stopped
// being fatal would look exactly like a passing test.
describe.concurrent("suspicious file patterns", () => {
  const junk = [
    "test/index.test.js",
    "tests/helper.js",
    "__tests__/x.js",
    "__snapshots__/x.snap",
    "coverage/lcov.info",
    ".github/workflows/ci.yml",
    "tsconfig.json",
    "tsconfig.build.json",
    "pnpm-lock.yaml",
    "bun.lock",
    "package-lock.json",
    "src/index.test.ts",
    "src/index.spec.tsx",
  ];

  for (const file of junk) {
    it(`refuses to publish ${file}`, () => {
      const [finding] = reviewPackedContent(["index.js", file], false);
      expect(finding?.rule).toBe("suspicious-file");
      expect(finding?.message).toContain(file);
      // Reporting rather than throwing must not turn the refusal into a warning: this is the
      // half of the change that a reader cannot see from the return type alone.
      expect(finding && isFatal(finding, false)).toBe(true);
    });
  }

  it("lets the author overrule the whole judgement at once", () => {
    expect(reviewPackedContent(["index.js", ...junk], true)).toEqual([]);
  });

  // The patterns are anchored at a path segment, so a file that merely CONTAINS one of these
  // words is ordinary source and must publish untouched — over-refusing here would make the
  // default unusable and push every author to the escape hatch.
  it("does not refuse ordinary source that merely reads like it", () => {
    expect(
      reviewPackedContent(
        ["latest/index.js", "src/contest.js", "protests.js", "my-tsconfig.json.js", "testing.js"],
        false,
      ),
    ).toEqual([]);
  });
});
