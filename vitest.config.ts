import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.bun.test.ts"],
    // Each case spawns package managers that spend much of their time on filesystem I/O, so
    // a cap at the core count leaves cores idle waiting on disk and oversubscription is what
    // fills those gaps. It has to be derived rather than picked: a literal tuned on a
    // developer's machine is a large multiple of a two-core CI runner's capacity, and the
    // only symptom is every case exceeding its wall-clock timeout while total CPU stays fine.
    maxConcurrency: availableParallelism() * 2,
    // Above the timeout `runCli` puts on the child, deliberately. Whichever bound fires first
    // decides the failure, and only the child's can actually kill the process — vitest failing
    // a case leaves its spawn running. Ordering them the other way leaks exactly what that
    // bound exists to prevent. Neither is a lane-speed knob: they cap pathological runs and a
    // healthy one never reaches them.
    testTimeout: 60_000,
  },
});
