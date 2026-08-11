import { defineConfig } from "tsdown";

// https://tsdown.dev/options/config-file
export default defineConfig({
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
