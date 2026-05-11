import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  outExtensions: () => ({ js: ".js" }),
  dts: false,
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
