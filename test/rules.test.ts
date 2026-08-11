import { describe, expect, it } from "vitest";

import {
  PublishCleanError,
  assertFilesField,
  assertFinalTarballIncludesCleanedFiles,
  assertNoLostConsumerFields,
  assertNoMonorepoProtocols,
  assertPublicPackage,
  assertRepositoryForTrustedPublish,
  customDevFields,
  githubRepositorySlug,
  isAtLeast,
  keptFields,
  normalizeDeclaredPath,
  stripManifest,
  unrecognizedFieldsReport,
  validatePackedFiles,
  wantsTrustedPublish,
} from "../src/rules";

/**
 * Exercises each rule directly, one input to one output. The end-to-end suite proves the CLI
 * reaches these and that a real packer emits the files they judge; what it cannot afford is
 * breadth, because every case there costs two package managers and a tarball. The evasions
 * that matter are cheap here, so this is where the matrices live.
 */

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
      expect(() => validatePackedFiles(["index.js", secret], false)).toThrow(PublishCleanError);
    });
  }

  // A guard that stopped at the first offender passed every single-file case above, and an
  // author who deletes the one name it printed would publish the rest.
  it("names every offender at once, not just the first", () => {
    let message = "";
    try {
      validatePackedFiles(["index.js", ...secrets], false);
    } catch (error) {
      message = (error as Error).message;
    }
    for (const secret of secrets) expect(message).toContain(secret);
  });

  it("keeps refusing critical files when suspicious checks are skipped", () => {
    expect(() => validatePackedFiles(["index.js", ".env"], true)).toThrow(
      "Critical files must not be published",
    );
  });

  it("passes a package that carries none of them", () => {
    expect(() =>
      validatePackedFiles(["index.js", "index.d.ts", "README.md", "src/env.js"], false),
    ).not.toThrow();
  });
});

// The default hygiene check, and the one an author meets most often: it refuses outright
// rather than warning, so a package shipping its own test tree or lockfile cannot publish
// until someone decides. `--skip-file-check` exists precisely because that verdict is a
// judgement call, unlike a leaked key, which is never one.
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
      expect(() => validatePackedFiles(["index.js", file], false)).toThrow("Suspicious files");
    });
  }

  it("lets the author overrule the whole judgement at once", () => {
    expect(() => validatePackedFiles(["index.js", ...junk], true)).not.toThrow();
  });

  // The patterns are anchored at a path segment, so a file that merely CONTAINS one of these
  // words is ordinary source and must publish untouched — over-refusing here would make the
  // default unusable and push every author to the escape hatch.
  it("does not refuse ordinary source that merely reads like it", () => {
    expect(() =>
      validatePackedFiles(
        ["latest/index.js", "src/contest.js", "protests.js", "my-tsconfig.json.js", "testing.js"],
        false,
      ),
    ).not.toThrow();
  });
});

describe.concurrent("manifest cleaning", () => {
  it("removes author-only fields and keeps consumer-facing ones", () => {
    const cleaned = stripManifest(
      {
        name: "x",
        version: "1.0.0",
        devDependencies: { typescript: "^5.0.0" },
        exports: "./index.js",
        repository: { type: "git", url: "git+https://example.test/x.git" },
      },
      [],
    );
    expect(cleaned.devDependencies).toBeUndefined();
    expect(cleaned.exports).toBe("./index.js");
    expect(cleaned.repository).toEqual({ type: "git", url: "git+https://example.test/x.git" });
  });

  // `files` selected the packed bytes and cannot select again: the artifact it describes is
  // already built, and an install extracts all of it unfiltered.
  it("removes files, which no longer decides anything once the tarball exists", () => {
    expect(stripManifest({ name: "x", files: ["index.js"] }, []).files).toBeUndefined();
  });

  it("keeps only the scripts an install actually runs", () => {
    const cleaned = stripManifest(
      { name: "x", scripts: { build: "tsc", test: "vitest", postinstall: "node index.js" } },
      [],
    );
    expect(cleaned.scripts).toEqual({ postinstall: "node index.js" });
  });

  it("drops the scripts block entirely when nothing in it survives", () => {
    expect(stripManifest({ name: "x", scripts: { build: "tsc" } }, []).scripts).toBeUndefined();
  });

  it("removes the extra fields the author nominated", () => {
    const cleaned = stripManifest({ name: "x", someToolConfig: { threshold: 5 } }, [
      "someToolConfig",
    ]);
    expect(cleaned.someToolConfig).toBeUndefined();
  });

  // Dropping a key some consumer resolves breaks a stranger's build with no signal here, so an
  // unrecognised field ships untouched and is reported instead.
  it("ships a field it does not recognise", () => {
    expect(
      stripManifest({ name: "x", someToolConfig: { threshold: 5 } }, []).someToolConfig,
    ).toEqual({ threshold: 5 });
  });
});

describe.concurrent("unrecognised field report", () => {
  it("names the field and offers both resolutions", () => {
    const message = unrecognizedFieldsReport({ name: "x", someTool: {} }, []);
    expect(message).toContain("someTool");
    expect(message).toContain(`"devFields": ["someTool"]`);
    expect(message).toContain(`"keepFields": ["someTool"]`);
  });

  // A report nobody trusts is noise, so a field the tool knows must never appear in it.
  it("stays silent about recognised fields", () => {
    expect(unrecognizedFieldsReport({ name: "x", funding: "u", exports: {} }, [])).toBeNull();
  });

  // A report whose only resolution deletes the field is unusable for any ecosystem this tool
  // does not know: a VS Code extension needs `contributes` in the artifact to work at all.
  it("stays silent about a field acknowledged through keepFields", () => {
    expect(unrecognizedFieldsReport({ name: "x", contributes: {} }, ["contributes"])).toBeNull();
  });
});

describe.concurrent("author configuration", () => {
  it("refuses devFields entries that would remove a field consumers resolve", () => {
    expect(() => customDevFields({ devFields: ["dependencies"] })).toThrow(
      "publish-clean.devFields",
    );
  });

  it("accepts devFields entries the tool does not recognise", () => {
    expect(customDevFields({ devFields: ["someToolConfig"] })).toEqual(["someToolConfig"]);
  });

  it("ignores a malformed configuration rather than acting on half of it", () => {
    expect(customDevFields({})).toEqual([]);
    expect(customDevFields({ devFields: "dependencies" })).toEqual([]);
    expect(keptFields({ keepFields: [1, "contributes"] })).toEqual(["contributes"]);
  });
});

describe.concurrent("monorepo-only dependency specs", () => {
  for (const spec of ["link:../bad", "workspace:*", "catalog:default", "portal:../bad"]) {
    it(`refuses ${spec}, which no consumer can resolve`, () => {
      expect(() => assertNoMonorepoProtocols({ dependencies: { bad: spec } })).toThrow(
        "unresolved monorepo-only dependency specs",
      );
    });
  }

  it("names the field and the offending spec so the author can find it", () => {
    expect(() => assertNoMonorepoProtocols({ peerDependencies: { bad: "workspace:^1" } })).toThrow(
      "peerDependencies.bad: workspace:^1",
    );
  });

  it("passes ordinary version ranges", () => {
    expect(() =>
      assertNoMonorepoProtocols({ dependencies: { a: "^1.0.0", b: "npm:c@2" } }),
    ).not.toThrow();
  });
});

describe.concurrent("declared manifest paths", () => {
  it("accepts paths inside the package", () => {
    expect(normalizeDeclaredPath("./index.js")).toBe("index.js");
    expect(normalizeDeclaredPath("dist/index.js")).toBe("dist/index.js");
    expect(normalizeDeclaredPath("./dist/../index.js")).toBe("index.js");
  });

  for (const escape of ["../secret.tgz", "./../secret.tgz", "/etc/passwd", "..", ".", ""]) {
    it(`refuses ${escape || "an empty path"}, which does not name a packed file`, () => {
      expect(normalizeDeclaredPath(escape)).toBeNull();
    });
  }
});

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

describe.concurrent("lost consumer fields", () => {
  // Cleaning is subtraction, so it fails by taking too much, and a field that quietly vanished
  // leaves no trace in the artifact. `repository` is the sharpest case: losing it breaks
  // provenance verification while the package still installs fine.
  it("refuses a published manifest that lost a field the source declared", () => {
    expect(() =>
      assertNoLostConsumerFields({ name: "x", repository: { url: "u" } }, { name: "x" }, []),
    ).toThrow("repository");
  });

  it("accepts fields removed by design or on request", () => {
    expect(() =>
      assertNoLostConsumerFields(
        { name: "x", devDependencies: {}, scripts: { build: "tsc" }, someTool: {} },
        { name: "x" },
        ["someTool"],
      ),
    ).not.toThrow();
  });
});

describe.concurrent("publishable manifest", () => {
  it("refuses a private package", () => {
    expect(() => assertPublicPackage({ private: true })).toThrow("private: true");
  });

  it("requires a non-empty files array unless the check is skipped", () => {
    expect(() => assertFilesField({ name: "x" }, false)).toThrow('non-empty "files" array');
    expect(() => assertFilesField({ name: "x", files: [] }, false)).toThrow('non-empty "files"');
    expect(() => assertFilesField({ name: "x" }, true)).not.toThrow();
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

// A tripwire for npm, not for the author: the cleaned directory has already been validated, so
// anything the final pack silently omits would ship a package missing a file that passed every
// earlier check. No fixture can provoke it, which is exactly why the rule is exercised here.
describe.concurrent("final tarball completeness", () => {
  it("refuses a tarball that dropped a validated file, naming what went missing", () => {
    expect(() =>
      assertFinalTarballIncludesCleanedFiles(
        ["index.js", "index.d.ts", "nested/deep.js"],
        ["index.js"],
      ),
    ).toThrow("index.d.ts");
  });

  it("accepts a tarball that carries more than the cleaned directory", () => {
    expect(() =>
      assertFinalTarballIncludesCleanedFiles(["index.js"], ["index.js", "package.json"]),
    ).not.toThrow();
  });
});
