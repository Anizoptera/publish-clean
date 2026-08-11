/**
 * Exercises each manifest rule directly, one input to one output. The end-to-end suite proves
 * the CLI reaches these; what it cannot afford is breadth, because every case there costs two
 * package managers and a tarball. The evasions that matter are cheap here.
 */
import { describe, expect, it } from "vitest";

import {
  assertFilesField,
  assertNoLostConsumerFields,
  assertNoMonorepoProtocols,
  assertPublicPackage,
  customDevFields,
  keptFields,
  stripManifest,
  unrecognizedFieldsReport,
  withRegistry,
} from "../src/manifest";

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

describe.concurrent("registry pinning", () => {
  it("leaves the manifest alone when no registry was chosen", () => {
    const pkg = { name: "x" };
    expect(withRegistry(pkg, null)).toBe(pkg);
  });

  it("creates publishConfig when the author declared none", () => {
    expect(withRegistry({ name: "x" }, "https://r.test").publishConfig).toEqual({
      registry: "https://r.test",
    });
  });

  // publishConfig carries consumer-facing settings such as `provenance` and `access`; losing
  // one while pinning a registry would silently change how the package is published.
  it("keeps the author's other publishConfig settings", () => {
    expect(
      withRegistry({ publishConfig: { access: "public", provenance: true } }, "https://r.test")
        .publishConfig,
    ).toEqual({ access: "public", provenance: true, registry: "https://r.test" });
  });

  it("overrides a registry the manifest already named", () => {
    expect(
      withRegistry({ publishConfig: { registry: "https://old.test" } }, "https://new.test")
        .publishConfig,
    ).toEqual({ registry: "https://new.test" });
  });

  it("does not mutate the manifest it was given", () => {
    const pkg = { name: "x", publishConfig: { access: "public" } };
    withRegistry(pkg, "https://r.test");
    expect(pkg.publishConfig).toEqual({ access: "public" });
  });
});
