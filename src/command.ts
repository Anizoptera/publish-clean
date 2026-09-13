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

/**
 * Why a spawn failed, in words the reader can act on.
 *
 * `ENOEXEC` earns a translation because every check a reader would run says the tool is fine:
 * the file is on PATH and carries the executable bit, and the kernel refuses it anyway. The
 * common cause is an installer that skipped build scripts — pnpm ships a shebang-less
 * placeholder at its bin path until its own install script puts the native binary there, and
 * blocking install scripts is the default in Bun and under `--ignore-scripts`. That placeholder
 * is deliberate and permanent on pnpm's side, so this is not a bug waiting to be fixed
 * upstream: pnpm/pnpm#14502 keeps it shebang-less so pnpm 11 can install pnpm 12, and requires
 * that wrapper installs allow lifecycle scripts.
 *
 * `EACCES` is the same complaint with a different repair, and it is not exotic: a global install
 * may write its entry point without the execute bit — measured 2026-09-13, `bun install -g pnpm`
 * leaves `pnpm.mjs` at 0644 — and `execvp` then finds the file and refuses it. The shell hides
 * this, because `command -v` reports only executables, so the tool looks absent while the spawn
 * says otherwise. Left bare it reaches the reader as `spawn pnpm EACCES`, which names neither.
 *
 * pnpm added a fallback that runs the placeholder through Node.js, but it only rescues callers
 * that go through a shell or a bin shim — a direct spawn cannot use it. This tool spawns
 * directly on purpose, because a shell would take the arguments a caller wrote after `--`, so
 * it is precisely the caller the fallback does not reach.
 *
 * Kept apart from `run` so the mapping is provable without a spawn, like `spawnArgs` above.
 * A spawning test could not prove it anyway: glibc's `execvp` retries an `ENOEXEC` file under
 * `/bin/sh`, so the same placeholder simply runs on Linux and the failure never appears there.
 * Measured on macOS, where Apple's libc does not retry.
 */
export function failureReason(failure: Error | undefined, exit: string): string {
  const code = isObject(failure) ? failure.code : undefined;
  if (code === "ENOENT") return "is not available in PATH";
  if (code === "EACCES")
    return (
      "is on PATH but carries no execute permission. Restore it with `chmod +x`, or reinstall " +
      "the tool"
    );
  if (code === "ENOEXEC")
    return (
      "is on PATH but cannot be executed: the file is a script with no shebang line, or a " +
      "program built for another architecture. An installer that skipped build scripts leaves " +
      "such a placeholder behind — reinstall it with its build scripts allowed"
    );
  return failure?.message ?? exit;
}

interface RunOptions {
  signal?: AbortSignal | undefined;
  output?: "capture" | "pack" | "publish" | "validator";
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
    // User validators are executables, never Windows command-shell shims.
    const invocation =
      output === "validator"
        ? ([command, [...args]] as const)
        : spawnArgs(command, args, process.platform);
    const child = spawn(invocation[0], invocation[1], {
      cwd,
      detached,
      // `pack` sends the child's STDOUT to our stderr, and both halves of that are load-bearing.
      // Live, because `pnpm pack` runs `prepack`/`prepare` — usually the package's build — and
      // capturing it would withhold a build's progress and warnings until the run ended, or
      // forever on success. To stderr, because stdout is this tool's machine-readable channel:
      // `--dry-run` writes the packed file list and cleaned manifest there for a caller to parse,
      // and `"inherit"` would interleave a packer's chatter into it. The cost is that pnpm's own
      // summary duplicates that file list, which beats either alternative.
      stdio:
        output === "capture" || output === "validator"
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
        failure = new PublishCleanError(`${command} exceeded the captured output limit.`);
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
        const reason = failureReason(failure, `exited with ${signal ?? status}`);
        reject(
          new PublishCleanError(
            `${command} ${reason}${stderr.trim() ? `: ${stderr.trim()}` : ""}${output === "validator" && stdout.trim() ? `\n${stdout.trim()}` : ""}`,
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
