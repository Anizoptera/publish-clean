import { defineConfig } from "tsdown";

// https://tsdown.dev/options/config-file
export default defineConfig({
  clean: true,
  entry: ["src/cli.ts"],
  format: "esm",
  fixedExtension: false,
  // Deliberately close to a no-op. Identifiers, whitespace and comments all survive, so
  // the published file stays readable: this package sits on a publish path and handles
  // registry credentials, and anyone who wants to audit the code they are about to trust
  // should be able to read it in node_modules without fetching the repository. Only the
  // genuinely dead parts are dropped.
  minify: {
    mangle: false,
    compress: { dropDebugger: true },
    codegen: { removeWhitespace: false },
  },
  treeshake: { moduleSideEffects: false },
  deps: { neverBundle: true },
  outDir: "dist",
  platform: "node",
  shims: false, // disable all shims/polyfills
  sourcemap: false,
  // Must not exceed the floor promised by package.json engines.node.
  target: ["es2022", "node20"],
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

  //banner: { js: '#!/usr/bin/env node' },
});
