/**
 * Runs the external tools this CLI depends on: `pnpm`, `npm` and `git`.
 *
 * Never `{ shell: true }`. It space-joins the argument vector with no escaping at all, which
 * Node runtime-deprecated in v24 as shell injection (DEP0190) — and this tool forwards
 * arguments a caller wrote after `--` straight into `npm publish`, so that vector is
 * attacker-shaped by design. Every spawn here passes an argument vector, never a command line.
 */
import { spawn } from "node:child_process";

import { PublishCleanError } from "./error";
import { isObject } from "./json";

/** Bound a hung version-manager shim without blocking the event loop. */
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
  const unsafe = [command, ...args].filter((argument) => /[&|<>^%()\r\n]/.test(argument));
  if (unsafe.length > 0)
    throw new PublishCleanError(
      `On Windows these arguments cannot be passed safely, because cmd.exe would interpret them:\n${unsafe.map((argument) => JSON.stringify(argument)).join("\n")}\n` +
        `Use arguments without & | < > ^ % ( ) or line breaks, or publish from Linux or macOS.`,
    );
  return ["cmd.exe", ["/d", "/c", command, ...args]];
}

interface RunOptions {
  signal?: AbortSignal | undefined;
  output?: "capture" | "pack" | "publish";
  timeout?: number;
}

/** Await child settlement before returning, so temporary files cannot be removed under a live packer. */
export function run(
  command: string,
  args: readonly string[],
  cwd: string,
  options: RunOptions = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  const output = options.output ?? "capture";
  // Interactive npm must stay in the terminal's foreground group to read an OTP.
  // Packing has no terminal input and owns a separate group for lifecycle cancellation.
  const detached = process.platform !== "win32" && output !== "publish";
  return new Promise((resolve, reject) => {
    const child = spawn(...spawnArgs(command, args, process.platform), {
      cwd,
      detached,
      stdio:
        output === "capture"
          ? ["ignore", "pipe", "pipe"]
          : output === "pack"
            ? ["ignore", process.stderr, process.stderr]
            : "inherit",
    });
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let stopping = false;
    let termination: Promise<void> | undefined;
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) {
          if (detached) process.kill(-child.pid, signal);
          else child.kill(signal);
        }
      } catch (error) {
        if (!isObject(error) || error.code !== "ESRCH")
          failure = error instanceof Error ? error : new Error(String(error));
      }
    };
    const stop = () => {
      if (stopping || child.pid === undefined) return;
      stopping = true;
      // POSIX process groups include lifecycle grandchildren. Windows uses taskkill's
      // tree operation and waits for that operation before releasing the temporary files.
      if (process.platform === "win32") {
        termination = new Promise((done) => {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            stdio: "ignore",
          });
          killer.on("error", (error) => {
            failure = error;
            child.kill();
          });
          killer.once("close", (status) => {
            if (status !== 0 && !failure)
              failure = new PublishCleanError("Unable to terminate the child process tree.");
            done();
          });
        });
      } else {
        killGroup("SIGTERM");
        // A deadline bounds a child ignoring cancellation; it never establishes readiness.
        escalation = setTimeout(() => killGroup("SIGKILL"), 1_000);
        escalation.unref();
      }
    };
    const timer =
      options.timeout === undefined
        ? undefined
        : setTimeout(() => {
            failure = new PublishCleanError(
              `${command} did not finish within ${options.timeout}ms.`,
            );
            stop();
          }, options.timeout);
    const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
      if (stream === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
      if (stdout.length + stderr.length > 1024 * 1024) {
        failure = new PublishCleanError(
          `${command} exceeded the output limit for a metadata query.`,
        );
        stdout = stdout.slice(-4096);
        stderr = stderr.slice(-4096);
        stop();
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.on("error", (error) => {
      failure = error;
    });
    options.signal?.addEventListener("abort", stop, { once: true });
    child.once("close", async (status, signal) => {
      if (stopping && process.platform !== "win32") killGroup("SIGKILL");
      await termination;
      clearTimeout(timer);
      clearTimeout(escalation);
      options.signal?.removeEventListener("abort", stop);
      if (options.signal?.aborted) {
        reject(options.signal.reason);
        return;
      }
      if (failure || status !== 0) {
        const reason =
          failure && isObject(failure) && failure.code === "ENOENT"
            ? "is not available in PATH"
            : (failure?.message ?? `exited with ${signal ?? status}`);
        reject(
          new PublishCleanError(
            `${command} ${reason}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
            { cause: failure },
          ),
        );
      } else resolve(stdout);
    });
    if (options.signal?.aborted) stop();
  });
}

/** Probe in the package directory: version-manager shims resolve their toolchain from cwd. */
export async function requireTool(
  name: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  return (await run(name, ["--version"], cwd, { signal, timeout: TOOL_PROBE_TIMEOUT_MS })).trim();
}
