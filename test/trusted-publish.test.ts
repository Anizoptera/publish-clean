/**
 * Refusing to publish under an identity the repository does not claim, and refusing a toolchain
 * npm will not sign with. Both decisions read only their arguments, so the environment a real
 * Actions run would provide is passed in rather than set process-wide.
 */
import { describe, expect, it } from "vitest";

import {
  assertRepositoryForTrustedPublish,
  githubRepositorySlug,
  isAtLeast,
  wantsTrustedPublish,
} from "../src/trusted-publish";

describe.concurrent("npm version floor", () => {
  const min = [11, 5, 1] as const;
  const cases: [readonly [number, number, number], boolean][] = [
    [[11, 5, 1], true],
    [[11, 5, 2], true],
    [[11, 6, 0], true],
    [[12, 0, 0], true],
    [[11, 5, 0], false],
    [[11, 4, 9], false],
    [[10, 9, 9], false],
  ];
  for (const [actual, expected] of cases) {
    it(`${actual.join(".")} is ${expected ? "" : "not "}enough for trusted publishing`, () => {
      expect(isAtLeast(actual, min)).toBe(expected);
    });
  }
});

describe.concurrent("repository slug", () => {
  it("reads every spelling npm accepts", () => {
    expect(githubRepositorySlug("git+https://github.com/A/b.git")).toBe("A/b");
    expect(githubRepositorySlug("https://github.com/A/b")).toBe("A/b");
    expect(githubRepositorySlug("git@github.com:A/b.git")).toBe("A/b");
  });
});

describe.concurrent("trusted publishing intent", () => {
  const LOCAL = {};
  // What a workflow granting `id-token: write` looks like — the permission that makes an
  // unflagged publish produce provenance, and the only reason to infer the intent at all.
  const CI = {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/",
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "Anizoptera/publish-clean",
  };

  it("is declared by --provenance", () => {
    expect(wantsTrustedPublish({}, ["--provenance"], LOCAL)).toBe(true);
  });

  it("is declared by publishConfig.provenance, which npm reads without the flag", () => {
    expect(wantsTrustedPublish({ publishConfig: { provenance: true } }, [], LOCAL)).toBe(true);
  });

  it("is inferred from a workflow that can mint an OIDC token", () => {
    expect(wantsTrustedPublish({}, [], CI)).toBe(true);
  });

  // Actions without that permission cannot produce provenance, so inferring the intent there
  // would fail the publish on a runtime requirement the author never asked for.
  it("is not assumed from an ordinary publish, in Actions or out of it", () => {
    expect(wantsTrustedPublish({ publishConfig: { provenance: false } }, [], LOCAL)).toBe(false);
    expect(wantsTrustedPublish({}, [], { GITHUB_ACTIONS: "true" })).toBe(false);
  });

  it("refuses to publish under an identity the repository does not claim", () => {
    expect(() =>
      assertRepositoryForTrustedPublish(
        { repository: { type: "git", url: "git+https://github.com/Other/repo.git" } },
        ["--provenance"],
        CI,
      ),
    ).toThrow("repository.url must match");
  });

  it("refuses a trusted publish that declares no repository at all", () => {
    expect(() => assertRepositoryForTrustedPublish({}, ["--provenance"], CI)).toThrow(
      "repository.url to match",
    );
  });

  it("accepts the repository it is actually running in", () => {
    expect(() =>
      assertRepositoryForTrustedPublish(
        {
          repository: { type: "git", url: "git+https://github.com/Anizoptera/publish-clean.git" },
        },
        ["--provenance"],
        CI,
      ),
    ).not.toThrow();
  });

  // Outside Actions nothing claims an identity to contradict, and this tool must not block an
  // ordinary local or third-party-CI publish that asks for provenance.
  it("does not police the repository when no identity is asserted", () => {
    expect(() =>
      assertRepositoryForTrustedPublish(
        { repository: { type: "git", url: "git+https://github.com/Other/repo.git" } },
        ["--provenance"],
        LOCAL,
      ),
    ).not.toThrow();
  });
});
