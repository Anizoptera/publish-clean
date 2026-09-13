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
  // Minified. The shipped file is not an audit surface — a devDependency, public sources, and
  // `--provenance` binding the tarball's sha512 to the commit that built it — so every transform
  // that preserves behaviour is taken, and only those. Measured 2026-09-13 on real `pnpm pack`
  // output: 63.2 kB tarball to 34.0 kB, 154.0 kB installed to 62.7 kB. Re-measure by setting
  // `minify: false`, packing, and restoring — the pair rots with every commit, and the CHANGELOG
  // bullet quoting it is a public claim.
  //
  // Two switches stay off because they break THIS tool, and both read as free wins off the option
  // list. `dropConsole` would delete every line it prints; all output here is `console.*`.
  // `mangleProps` is worth a further 10% and renames properties that cross a process boundary —
  // the manifests this tool rewrites, and what the tests read back — so 41 of them fail.
  //
  // `mangle.keepNames` costs 774 bytes — 2.9% of what minifying saves — and buys back a readable
  // stack: an unexpected throw here is a defect and prints its frames (`main`'s catch in
  // `src/cli.ts`), and `at e (cli.js:…)` is not a bug report anyone can act on. oxc leaves
  // function and class declarations under their own names and still mangles locals. Not to be
  // confused with `compress.keepNames`, a different option governing `Function.prototype.name`
  // through compress: adding it costs 12 bytes and preserves not one further name. Mangling these
  // is the last headroom inside tsdown; going lower needs
  // a second minifier (`@swc/core` before `oxc-minify` reaches 32.7 kB) for a native
  // devDependency, a post-build step on an irreversible publish, and mangled frames back.
  minify: { mangle: { keepNames: true } },
  treeshake: { moduleSideEffects: false },
  deps: { neverBundle: true },
  outDir: "dist",
  platform: "node",
  shims: false, // disable all shims/polyfills
  // Off, and not the way to get readable stacks either. A map embeds `sourcesContent`, the whole
  // of `src/`, tripling the tarball to 112.1 kB — more than minifying saves. It would not even
  // name the frames: on Node 24.21.0 `--enable-source-maps` recovers file and line while the
  // function still prints as `e`, and without that flag Node ignores the map.
  sourcemap: false,
  // Stay within engines.node; trusted publishing checks its stricter runtime floor separately.
  // Not a size lever: es2022, node22, esnext and unset all emit the same bytes, so this floor is
  // free and raising it gains nothing.
  target: ["es2022", "node22"],
  tsconfig: "./tsconfig.build.json",

  // publint reads the manifest against the emitted files, so it needs no plugin beyond
  // the devDependency of the same name. `local-only` is not a CI gap: this run is fast local
  // feedback, and CI runs publint against the extracted tarball through
  // scripts/check-cleaned-artifact.ts — the bytes a consumer installs. Verified: this plugin
  // emits nothing under CI=true.
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
