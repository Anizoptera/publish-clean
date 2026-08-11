/**
 * Runs the external tools this CLI depends on: `pnpm`, `npm` and `git`.
 *
 * No shell, ever. `execFileSync` passes the argument vector to the OS untouched, while
 * `{ shell: true }` space-joins it with no escaping at all — which Node runtime-deprecated in
 * v24 as shell injection (DEP0190). This tool forwards arguments a caller wrote after `--`
 * straight into `npm publish`, so that vector is attacker-shaped by design.
 */
import { execFileSync } from "node:child_process";

import { PublishCleanError } from "./error";
import { isObject } from "./json";

/**
 * The probe below is bounded because a wedged shim would otherwise hang the publish with no
 * end: `execFileSync` blocks this thread, so no timer here could ever interrupt it. The bound
 * belongs on the spawn itself. It stays generous because the only job is to separate a tool
 * that answers from one that never will.
 */
const TOOL_PROBE_TIMEOUT_MS = 10_000;

export function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Runs a command with its streams attached to this process instead of captured.
 *
 * Reserved for `npm publish`. Every other command here is run for its output or its
 * effect, but the publish is the one irreversible step, and npm's output is the only
 * receipt the operator gets: the version that went out, the tarball size, the integrity
 * hash, and the registry's own wording when it refuses. `run` would swallow all of it on
 * success and hold the failure text until the process exits, which in CI means a log
 * that says nothing about the one action that cannot be undone.
 */
export function runAttached(command: string, args: readonly string[], cwd: string): void {
  execFileSync(command, [...args], { cwd, stdio: ["ignore", "inherit", "inherit"] });
}

/** Child output survives only on the thrown error, and is lost unless read off it here. */
export function outputFromError(error: unknown, key: "stderr" | "stdout"): string {
  if (!isObject(error)) return "";
  const output = error[key];
  if (typeof output === "string") return output.trim();
  if (output instanceof Uint8Array) return Buffer.from(output).toString("utf8").trim();
  return "";
}

/**
 * A required tool can fail three ways, and each one asks something different of the
 * reader, so the probe reports what it observed instead of assuming the common case.
 * A version-manager shim (asdf, mise, volta, corepack) resolves in PATH and still refuses
 * to run when no version is pinned; calling that absence sends the reader to verify the
 * one thing already correct, and `which pnpm` then agrees with them and not with us. The
 * shim's own message names the fix, so it is forwarded rather than replaced.
 */
function toolFailureReason(cause: unknown): string {
  if (isObject(cause)) {
    if (cause.code === "ENOENT") return "is not available in PATH";
    if (cause.code === "ETIMEDOUT")
      return `did not answer --version within ${TOOL_PROBE_TIMEOUT_MS}ms`;
  }
  const stderr = outputFromError(cause, "stderr");
  return `is present but failed to run${stderr ? `: ${stderr}` : ""}`;
}

export function requireTool(name: string): void {
  try {
    execFileSync(name, ["--version"], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: TOOL_PROBE_TIMEOUT_MS,
    });
  } catch (cause) {
    throw new PublishCleanError(`Required tool "${name}" ${toolFailureReason(cause)}.`, { cause });
  }
}
