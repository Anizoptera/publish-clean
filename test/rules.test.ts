import { describe, expect, it, vi } from "vitest";

import {
  PublishCleanError,
  assertFilesField,
  assertNoLostConsumerFields,
  assertNoMonorepoProtocols,
  assertPublicPackage,
  assertRepositoryForTrustedPublish,
  customDevFields,
  githubRepositorySlug,
  isAtLeast,
  keptFields,
  normalizeDeclaredPath,
  reportUnrecognizedFields,
  stripManifest,
  validatePackedFiles,
  wantsTrustedPublish,
} from "../src/rules";

/**
 * Exercises each rule directly, one input to one output. The end-to-end suite proves the CLI
 * reaches these and that a real packer emits the files they judge; what it cannot afford is
 * breadth, because every case there costs two package managers and a tarball. The evasions
 * that matter are cheap here, so this is where the matrices live.
 */

/** Runs `fn` and returns what it wrote to `console.warn`, which is where reports go. */
function captured(fn: () => void): string {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    fn();
    return warn.mock.calls.map((call) => call.join(" ")).join("\n");
  } finally {
    warn.mockRestore();
  }
}

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
    const message = captured(() => reportUnrecognizedFields({ name: "x", someTool: {} }, []));
    expect(message).toContain("someTool");
    expect(message).toContain(`"devFields": ["someTool"]`);
    expect(message).toContain(`"keepFields": ["someTool"]`);
  });

  // A report nobody trusts is noise, so a field the tool knows must never appear in it.
  it("stays silent about recognised fields", () => {
    expect(
      captured(() => reportUnrecognizedFields({ name: "x", funding: "u", exports: {} }, [])),
    ).toBe("");
  });

  // A report whose only resolution deletes the field is unusable for any ecosystem this tool
  // does not know: a VS Code extension needs `contributes` in the artifact to work at all.
  it("stays silent about a field acknowledged through keepFields", () => {
    expect(
      captured(() => reportUnrecognizedFields({ name: "x", contributes: {} }, ["contributes"])),
    ).toBe("");
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

// Not concurrent: these read the ambient environment, and stubbing it is process-wide.
describe("trusted publishing intent", () => {
  it("is declared by --provenance", () => {
    expect(wantsTrustedPublish({}, ["--provenance"])).toBe(true);
  });

  it("is declared by publishConfig.provenance, which npm reads without the flag", () => {
    expect(wantsTrustedPublish({ publishConfig: { provenance: true } }, [])).toBe(true);
  });

  it("is not assumed from an ordinary publish", () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    expect(wantsTrustedPublish({ publishConfig: { provenance: false } }, [])).toBe(false);
    vi.unstubAllEnvs();
  });

  it("refuses to publish under an identity the repository does not claim", () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_REPOSITORY", "Anizoptera/publish-clean");
    try {
      expect(() =>
        assertRepositoryForTrustedPublish(
          { repository: { type: "git", url: "git+https://github.com/Other/repo.git" } },
          ["--provenance"],
        ),
      ).toThrow("repository.url must match");
      expect(() => assertRepositoryForTrustedPublish({}, ["--provenance"])).toThrow(
        "repository.url to match",
      );
      expect(() =>
        assertRepositoryForTrustedPublish(
          {
            repository: { type: "git", url: "git+https://github.com/Anizoptera/publish-clean.git" },
          },
          ["--provenance"],
        ),
      ).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
