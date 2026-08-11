import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.bun.test.ts"],
    // Each case spawns package managers that spend much of their time on filesystem I/O,
    // so the default cap of 5 leaves cores idle waiting on disk. Deliberately above the
    // core count: oversubscription is what fills those gaps, and the scheduler handles
    // the excess. Raise only against a measurement — past the point where the work is
    // genuinely CPU-bound this trades wall-clock for contention.
    maxConcurrency: 24,
  },
});
