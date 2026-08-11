/**
 * Runs the external tools this CLI depends on: `pnpm`, `npm` and `git`.
 *
 * Never `{ shell: true }`. It space-joins the argument vector with no escaping at all, which
 * Node runtime-deprecated in v24 as shell injection (DEP0190) — and this tool forwards
 * arguments a caller wrote after `--` straight into `npm publish`, so that vector is
 * attacker-shaped by design. Every spawn here passes an argument vector, never a command line.
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

/**
 * Windows cannot launch `pnpm` or `npm` directly: both are `.cmd` shims there, and Node's own
 * documentation states a `.cmd` "cannot be launched using child_process.execFile()" — so the
 * spawn fails as ENOENT and the probe below would report a working package manager as missing.
 * Of the three routes Node names, this is the one that adds no parsing of our own: cmd.exe runs
 * the shim AND does the PATH/PATHEXT lookup, so no name resolution belongs here either.
 *
 * `/d` skips registry AutoRun commands, which would otherwise execute inside a publish. Neither
 * `/s` nor `windowsVerbatimArguments` is used: without them Node applies its ordinary C-runtime
 * quoting to every argument, exactly as on any other platform, so this file owns no escaping.
 * What it owns instead is the refusal below, which is what keeps that true.
 */
export function spawnArgs(
  command: string,
  args: readonly string[],
  platform: string,
): [string, string[]] {
  if (platform !== "win32") return [command, [...args]];
  // Refused rather than escaped, because routing through cmd.exe adds a parsing layer above
  // the one Node handles: libuv quotes an argument only when it holds a space, tab or quote
  // (`quote_cmd_arg`, src/win/process.c), so anything here reaches cmd unquoted and cmd acts
  // on it — `npm publish C:\R&D\x.tgz` would run `D\x.tgz` as a second command. Escaping it
  // correctly means encoding cmd's quoting rules on the one step nobody can take back, where
  // being subtly wrong corrupts a publish silently; refusing can only ever stop one, and says
  // exactly which argument and why. Build the escaper when a real path like this appears.
  const unsafe = [command, ...args].filter((argument) => /[&|<>^%()]/.test(argument));
  if (unsafe.length > 0)
    throw new PublishCleanError(
      `On Windows these arguments cannot be passed safely, because cmd.exe would interpret them:\n${unsafe.join("\n")}\n` +
        `Move the package to a path without & | < > ^ % ( ), or publish from Linux or macOS.`,
    );
  return ["cmd.exe", ["/d", "/c", command, ...args]];
}

export function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(...spawnArgs(command, args, process.platform), {
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
  execFileSync(...spawnArgs(command, args, process.platform), {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
  });
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
  // Not "is present but failed": on Windows the spawn goes through cmd.exe, which always
  // exists, so a genuinely missing tool arrives here as an exit code and cmd's own
  // "is not recognized as an internal or external command" — a message that would then be
  // introduced by a claim contradicting it. The forwarded stderr carries the diagnosis either way.
  return `failed to run${stderr ? `: ${stderr}` : ""}`;
}

export function requireTool(name: string): void {
  try {
    execFileSync(...spawnArgs(name, ["--version"], process.platform), {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: TOOL_PROBE_TIMEOUT_MS,
    });
  } catch (cause) {
    throw new PublishCleanError(`Required tool "${name}" ${toolFailureReason(cause)}.`, { cause });
  }
}
