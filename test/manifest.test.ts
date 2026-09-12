/**
 * Exercises each manifest rule directly, one input to one output. The end-to-end suite proves
 * the CLI reaches these; what it cannot afford is breadth, because every case there costs two
 * package managers and a tarball. The evasions that matter are cheap here.
 */
import { customDevFields, keptFields, packageConfig } from "../src/config";
import { describe, expect, it } from "vitest";

import { isFatal } from "../src/finding";
import type { JsonObject } from "../src/json";
import {
  filesFieldRefusal,
  assertNoLostConsumerFields,
  privatePackageRefusal,
  reviewMonorepoProtocols,
  stripManifest,
  unrecognizedFieldsReport,
} from "../src/manifest";
import { assertRegistry, reviewRegistryDestinations, withRegistry } from "../src/registry";

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

  it("preserves helper scripts when a consumer lifecycle is present", () => {
    const cleaned = stripManifest(
      { name: "x", scripts: { build: "tsc", test: "vitest", postinstall: "node index.js" } },
      [],
    );
    expect(cleaned.scripts).toEqual({ build: "tsc", test: "vitest", postinstall: "node index.js" });
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

  it("reads an absent configuration as no configuration", () => {
    expect(customDevFields({})).toEqual([]);
    expect(keptFields({})).toEqual([]);
  });

  // Acting on the readable half of a malformed option is the failure mode that matters here:
  // the author asked for a field to be stripped, and a silently dropped entry publishes it
  // with nothing anywhere saying so.
  it("refuses a malformed option instead of acting on the part it can read", () => {
    expect(() => customDevFields({ devFields: "dependencies" })).toThrow(/array of strings/);
    expect(() => keptFields({ keepFields: [1, "contributes"] })).toThrow(/array of strings/);
  });

  it("refuses a field listed as both stripped and kept", () => {
    expect(() =>
      customDevFields({ devFields: ["contributes"], keepFields: ["contributes"] }),
    ).toThrow(/both devFields and keepFields/);
  });

  // A typo in this block is invisible in the artifact: `devFeilds` publishes the very field
  // the author wrote the config to remove.
  it("refuses an unknown option key rather than ignoring it", () => {
    expect(() => packageConfig({ "publish-clean": { devFeilds: ["x"] } })).toThrow(
      /Unknown "publish-clean" manifest options/,
    );
  });

  it("passes through a manifest with no configuration block", () => {
    expect(packageConfig({})).toEqual({});
  });
});

describe.concurrent("monorepo-only dependency specs", () => {
  /**
   * The rule reports rather than throws, so the rest of the run still happens. What must not
   * change is the verdict, so every case here asserts the refusal as well as the message: a
   * finding this rule emits is unhealed and `breaks`, which stops the publish with no flag able
   * to reach it.
   */
  const refusal = (pkg: JsonObject, files?: string[]): string => {
    const found = reviewMonorepoProtocols(pkg, files);
    expect(found.every((finding) => isFatal(finding, false))).toBe(true);
    return found.map((finding) => finding.message).join("\n");
  };

  for (const spec of ["link:../bad", "workspace:*", "catalog:default", "portal:../bad"]) {
    it(`refuses ${spec}, which no consumer can resolve`, () => {
      expect(refusal({ dependencies: { bad: spec } })).toContain(
        "unresolved monorepo-only dependency specs",
      );
    });
  }

  it("names the field and the offending spec so the author can find it", () => {
    expect(refusal({ peerDependencies: { bad: "workspace:^1" } })).toContain(
      "peerDependencies.bad: workspace:^1",
    );
  });

  it("passes ordinary version ranges", () => {
    expect(refusal({ dependencies: { a: "^1.0.0", b: "npm:c@2" } })).toBe("");
  });

  it("rejects local references absent from the artifact while permitting shipped vendor packages", () => {
    for (const spec of [
      "file:../outside",
      "./missing",
      ".\\missing",
      "file:C:/vendor",
      "file:/absolute",
      "git+file:///repo",
      "file:%zz",
    ])
      expect(
        refusal({ dependencies: { local: spec } }, ["index.js", "C:/vendor/package.json"]),
      ).toMatch(/local target/);
    expect(refusal({ dependencies: { local: "file:vendor" } }, ["vendor/package.json"])).toBe("");
    expect(refusal({ dependencies: { local: "file:vendor.tgz" } }, ["vendor.tgz"])).toBe("");
    expect(refusal({ dependencies: { remote: "https://example.test/catalog:fixture.tgz" } })).toBe(
      "",
    );
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
  it("refuses a private package and nothing else", () => {
    expect(privatePackageRefusal({ private: true })).toContain("private: true");
    // `private` is a boolean field and the check is an identity test, so every other value it
    // can legally hold — including the string npm itself ignores — must let the publish through.
    for (const value of [false, undefined, "true", 1])
      expect(privatePackageRefusal({ private: value })).toBeNull();
  });

  it("requires a files array with usable entries unless the check is skipped", () => {
    // Each of these produces a file set nobody declared: the packer falls back to ignore files.
    // The blank and non-string entries are the ones a hand-edited manifest actually contains,
    // and an array that is merely PRESENT is what a length check alone would accept.
    for (const files of [undefined, [], ["   "], [""], [1], ["index.js", "  "], "index.js"])
      expect(filesFieldRefusal({ name: "x", files }, false)).toContain('"files"');
    expect(filesFieldRefusal({ name: "x", files: ["index.js"] }, false)).toBeNull();
    expect(filesFieldRefusal({ name: "x" }, true)).toBeNull();
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

describe("strict manifest configuration", () => {
  it.each([null, false, "config", []])("rejects a non-object configuration %j", (value) => {
    expect(() => packageConfig({ "publish-clean": value })).toThrow(/must be an object/);
  });
  it.each(["allowSuspicious", "skipFileCheck", "noGitChecks"])(
    "requires a boolean for %s",
    (key) => {
      expect(() => packageConfig({ "publish-clean": { [key]: "false" } })).toThrow(/boolean/);
    },
  );
  it.each([42, "registry.npmjs.org", "file:///tmp/registry", ""])(
    "rejects invalid registries %j",
    (registry) => {
      expect(() => packageConfig({ "publish-clean": { registry } })).toThrow(/HTTP/);
    },
  );
  it.each(["svelte", "style", "sass", "react-native", "unpkg", "jsdelivr", "config", "man"])(
    "protects consumer field %s from devFields",
    (field) => {
      expect(() => customDevFields({ devFields: [field] })).toThrow(/cannot remove/);
    },
  );
  it("emits valid JSON suggestions for arbitrary unknown field names", () => {
    const key = 'a"\n\\b';
    const report = unrecognizedFieldsReport({ [key]: true }, []);
    expect(report).toContain(JSON.stringify(key));
    expect(report).not.toContain("were published");
  });
  it("pins the scope-specific registry in the artifact as well", () => {
    expect(withRegistry({ name: "@audit/pkg" }, "https://r.test").publishConfig).toEqual({
      registry: "https://r.test",
      "@audit:registry": "https://r.test",
    });
  });
});

it.each([
  "https://fixture-secret@registry.example/",
  "https://user:fixture-secret@registry.example/",
  "https://:fixture-secret@registry.example/",
  "https://fixture-secret@[invalid/",
])("rejects registry credentials without retaining the URL: %s", (registry) => {
  // The two routes differ in form and must not differ in verdict: a registry named on the command
  // line throws, one found in the manifest is reported alongside every other defect — and both
  // refuse. Whichever route, the text must not carry the credential, because an error message is
  // what an author pastes into an issue. The `cause` check is the subtle half: the URL parser's
  // exception retains its input, so chaining one would leak the secret through a property nobody
  // reads on purpose.
  try {
    assertRegistry(registry);
    expect.fail("credential-bearing registry accepted");
  } catch (error) {
    expect(String(error)).toMatch(/Registry/);
    expect(String(error)).not.toContain("fixture-secret");
    expect(error).not.toHaveProperty("cause");
  }
  for (const publishConfig of [{ registry }, { "@scope:registry": registry }]) {
    const [finding, ...rest] = reviewRegistryDestinations({ publishConfig });
    expect(rest).toEqual([]);
    expect(finding && isFatal(finding, false)).toBe(true);
    expect(JSON.stringify(finding)).toMatch(/Registry/);
    expect(JSON.stringify(finding)).not.toContain("fixture-secret");
  }
});

it.each([null, [], [""], ["   "], ["node", 42], ["node", "a\0b"], "node check.js"])(
  "rejects invalid artifact validator argv: %j",
  (validateArtifact) => {
    expect(() => packageConfig({ "publish-clean": { validateArtifact } })).toThrow(
      "validateArtifact",
    );
  },
);
it("preserves literal validator arguments including empty optional arguments", () => {
  const argv = ["node", "check.mjs", "", "a; b", "$(touch nope)"];
  expect(packageConfig({ "publish-clean": { validateArtifact: argv } }).validateArtifact).toEqual(
    argv,
  );
});
