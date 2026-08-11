import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.bun.test.ts"],
    // One case = one core. Measured: a full pack pipeline is 0.67s wall for 0.70s of CPU, so
    // it is compute, not disk — the cases spend their time parsing two package managers'
    // bundles, and each waits on its own child rather than overlapping with it. Cores is
    // therefore the throughput ceiling and anything above it only adds contention.
    // Oversubscribing measured ~2x slower than this arithmetic predicts on a four-core
    // runner, and a literal here is worse still: one tuned on a sixteen-thread machine is a
    // six-fold oversubscription there, whose only symptom is every case blowing its
    // wall-clock timeout while total CPU stays healthy.
    maxConcurrency: availableParallelism(),
    // Above the timeout `runCli` puts on the child, deliberately. Whichever bound fires first
    // decides the failure, and only the child's can actually kill the process — vitest failing
    // a case leaves its spawn running. Ordering them the other way leaks exactly what that
    // bound exists to prevent. Neither is a lane-speed knob: they cap pathological runs and a
    // healthy one never reaches them.
    testTimeout: 60_000,
  },
});
