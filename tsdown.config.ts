import { readFileSync } from "node:fs";

import { defineConfig } from "tsdown";

/**
 * Two lines on the one file consumers install: what it is, and its licence.
 *
 * The licence line is the SPDX short-form identifier, which is the entire standard for
 * declaring a file's licence to a scanner that sees the file and nothing around it. REUSE
 * 3.3 requires the tag be followed by a valid SPDX License Expression and terminated by a
 * newline — hence line comments, not a `/* *\/` block, whose closing delimiter would sit
 * inside the tag value for every parser to strip and none is obliged to. It goes directly
 * under the shebang because that is where scanners and the kernel convention expect it.
 *
 * A copyright notice is deliberately absent. REUSE compliance would additionally want one
 * `SPDX-FileCopyrightText:` line per holder; the holders are declared in LICENSE, which
 * ships in the same tarball, and restating them here creates a second place to update.
 *
 * Every value is read from the manifest, so the artifact cannot claim a licence or a version
 * the package does not. Nothing volatile goes in — no build date, no machine, no git hash —
 * because the artifact must stay byte-identical across runs, which is what lets a re-run
 * reproduce a published tarball exactly.
 */
const manifest: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("package.json", import.meta.url), "utf8"),
);
const field = (key: string): string => {
  const value = manifest[key];
  // Fails the build rather than emitting `undefined` into every consumer's copy, where no
  // later check looks and no test would notice.
  if (typeof value !== "string" || value === "")
    throw new Error(`package.json "${key}" must be a non-empty string for the dist banner.`);
  return value;
};
const banner = [
  `// SPDX-License-Identifier: ${field("license")}`,
  `// ${field("name")} ${field("version")} | ${field("homepage")}`,
].join("\n");

// https://tsdown.dev/options/config-file
export default defineConfig({
  banner: { js: banner },
  clean: true,
  entry: ["src/cli.ts"],
  format: "esm",
  fixedExtension: false,
  // Off, so `dist/cli.js` reads as the source does. This package sits on a publish path and
  // handles registry credentials, so someone deciding whether to trust it must be able to
  // audit the file in `node_modules` and see the same code the repository shows. Measured
  // 2026-08-11: enabling it costs 1,157 gzipped bytes on a once-per-developer devDependency
  // and buys a file an auditor can no longer diff against `src/` — `mangle: false` does not
  // prevent that, because compress alone rewrote `const` to `let`, `===` to `==`, an early
  // return into a nested branch, and `if (a) b()` into `a && b()`. Comments survived and
  // described control flow that no longer matched them.
  minify: false,
  treeshake: { moduleSideEffects: false },
  deps: { neverBundle: true },
  outDir: "dist",
  platform: "node",
  shims: false, // disable all shims/polyfills
  sourcemap: false,
  // Must not exceed the floor promised by package.json engines.node, which is the Node version
  // npm's trusted publishing needs — this tool cannot do its job below it.
  target: ["es2022", "node22"],
  tsconfig: "./tsconfig.build.json",

  // publint reads the manifest against the emitted files, so it needs no plugin beyond
  // the devDependency of the same name.
  //
  // tsdown's `unused` option is deliberately absent. It loads `unplugin-unused`, which
  // tsdown declares as an *optional* peer: nothing installs it, and the build fails at
  // import time the moment the option is set without a matching devDependency. It would
  // also have nothing to report here, because it flags declared-but-unimported runtime
  // dependencies and this package must declare none at all. That stronger invariant is
  // asserted directly on the cleaned artifact in scripts/check-cleaned-artifact.ts,
  // where it is checked against what consumers actually install.
  publint: { enabled: "local-only", level: "error", strict: true },
});
