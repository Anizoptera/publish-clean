import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.bun.test.ts"],
    // Derived, never a literal: one tuned on a sixteen-thread machine is a six-fold
    // oversubscription of a four-core runner, and the only symptom is every case blowing its
    // wall-clock timeout while total CPU stays healthy.
    //
    // Doubled because a case is not one solid core of work. It is 0.67s wall for 0.70s of
    // CPU, but that CPU sits in two package-manager children with the harness idle between
    // them, around spawns, a temp directory and a tar. Sizing to cores exactly leaves those
    // gaps unfilled and measured slower on the runner than doubling; above 2x there is
    // nothing left to fill and contention wins.
    maxConcurrency: availableParallelism() * 2,
    // Above the timeout `runCli` puts on the child, deliberately. Whichever bound fires first
    // decides the failure, and only the child's can actually kill the process — vitest failing
    // a case leaves its spawn running. Ordering them the other way leaks exactly what that
    // bound exists to prevent. Neither is a lane-speed knob: they cap pathological runs and a
    // healthy one never reaches them.
    testTimeout: 60_000,
  },
});
