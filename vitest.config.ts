import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Derived, never a literal: a value tuned on a sixteen-thread machine is a six-fold
    // oversubscription of a four-core runner, and its only symptom is every case blowing its
    // wall-clock timeout while total CPU stays healthy — which is how this was found.
    //
    // Cores exactly, because a case is essentially one core of work: 0.67s wall for 0.70s of
    // CPU, spent parsing two package managers' bundles. Doubling it measured the same on the
    // runner, so this number is not the lever it looks like — the suite is bounded by total
    // CPU over cores, and the only way down from there is fewer full pack pipelines.
    maxConcurrency: availableParallelism(),
    // Above the timeout `runCli` puts on the child, deliberately. Whichever bound fires first
    // decides the failure, and only the child's can actually kill the process — vitest failing
    // a case leaves its spawn running. Ordering them the other way leaks exactly what that
    // bound exists to prevent. Neither is a lane-speed knob: they cap pathological runs and a
    // healthy one never reaches them.
    testTimeout: 60_000,
  },
});
