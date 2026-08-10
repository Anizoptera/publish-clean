import { defineConfig } from "tsdown";

// https://tsdown.dev/options/config-file
export default defineConfig({
  clean: true,
  entry: ["src/cli.ts"],
  format: "esm",
  fixedExtension: false,
  minify: {
    mangle: false,
    compress: { dropDebugger: true },
    codegen: { removeWhitespace: false },
  },
  treeshake: { moduleSideEffects: false },
  deps: { skipNodeModulesBundle: true },
  outDir: "dist",
  platform: "node",
  shims: false, // disable all shims/polyfills
  sourcemap: false,
  target: ["es2022", "node18"],
  tsconfig: "./tsconfig.build.json",

  publint: { enabled: "local-only", level: "error", strict: true },
  unused: { enabled: true, level: "error" },
  devtools: {},

  //banner: { js: '#!/usr/bin/env node' },
});
