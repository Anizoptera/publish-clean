// Keep npm's publication options separate from arguments that select an unchecked artifact.
import { parseArgs } from "node:util";
import { PublishCleanError } from "./error";
import { assertRegistry } from "./manifest";

const PUBLISH_OPTIONS = new Map<string, "string" | "boolean">([
  ["access", "string"],
  ["tag", "string"],
  ["otp", "string"],
  ["registry", "string"],
  ["provenance-file", "string"],
  ["provenance", "boolean"],
  ["dry-run", "boolean"],
  ["ignore-scripts", "boolean"],
  ["json", "boolean"],
  ["loglevel", "string"],
]);

/** npm reparses even equals-form values as flags; reject flag-shaped values before forwarding. */
function publicationArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    const equal = arg.indexOf("=");
    const flag = equal < 0 ? arg : arg.slice(0, equal);
    const negative = flag.startsWith("--no-");
    const name = flag.slice(negative ? 5 : 2);
    const type = flag.startsWith("--") ? PUBLISH_OPTIONS.get(name) : undefined;
    if (!type || (negative && type !== "boolean"))
      throw new PublishCleanError(
        `After --, use publication options only: ${[...PUBLISH_OPTIONS.keys()].join(", ")}. Package operands and workspace selectors are forbidden.`,
      );
    let value = equal < 0 ? undefined : arg.slice(equal + 1);
    if (
      value === undefined &&
      (type === "string" || args[index + 1] === "true" || args[index + 1] === "false")
    )
      value = args[++index];
    if (type === "boolean") {
      value ??= "true";
      if (value !== "true" && value !== "false")
        throw new PublishCleanError(`--${name} requires true or false.`);
      if (negative) value = value === "true" ? "false" : "true";
    } else if (!value || value.startsWith("-")) {
      throw new PublishCleanError(
        `--${name} requires a value that does not start with -. Use ./ for a filename starting with -.`,
      );
    }
    if (name === "registry") assertRegistry(value);
    result.push(`--${name}=${value}`);
  }
  return result;
}

/**
 * The whole interface in one screen, because this is where an out-of-context reader lands:
 * the flags, the manifest config block that sets the same policies durably, and the `--`
 * convention that decides which arguments this tool reads and which npm does. Anything a
 * user must know to publish correctly belongs here, not only in the README, which is not
 * installed next to the binary.
 */
export const HELP = `publish-clean [options] [package-dir] [-- npm publish args]
       publish-clean verify [package-dir]

Packs with pnpm, strips developer-only fields from the packed manifest, validates the
artifact, and publishes that exact tarball with npm. Arguments after \`--\` go to
\`npm publish\` as publication options (e.g. --access public --tag next --provenance).
Allowed: ${[...PUBLISH_OPTIONS.keys()].map((name) => `--${name}`).join(", ")}.
Additional package operands and workspace selectors are rejected.

Options:
  verify [dir]           Pack, clean and check; publish nothing. Works on private packages.
  --verify-only          The same as the verify subcommand, for scripts that take flags only.
  --strict               Treat warnings as errors. Never makes an already-repaired finding fatal.
  --no-heal              Report repairable exports/imports defects without repairing them.
  --dry-run              Pack, clean and validate; print the file list and manifest, publish nothing.
  --guard-only           Deprecated alias for verify, on a public package.
  --tarball-out DIR      Also write the validated tarball into DIR, for attestation or release upload.
  --registry URL         Publish to URL, and record it in the artifact's publishConfig.
  --no-git-checks        Publish from a working tree with uncommitted changes.
  --skip-file-check      Allow a manifest with no "files" array.
  --allow-suspicious     Allow tests, CI config, lockfiles or tsconfig in the published artifact.
  -h, --help             Show this help.
  -v, --version          Show the publish-clean version.

Manifest configuration, under a "publish-clean" key in package.json:
  validateArtifact string[] Executable and arguments; appends the final tarball path in every mode.
  devFields    string[]  Extra fields to strip. Refused for fields consumers resolve.
  keepFields   string[]  Fields to acknowledge, so they stop being reported as unrecognised.
  registry     string    Default for --registry.
  heal         boolean   Set false to report exports/imports repairs without applying them.
  allowUnreferenced string[] Shipped files nothing imports on purpose: a binary a loader finds by
                        path, a directory read at run time. Prefixes match whole subtrees.
  noGitChecks  boolean   Default for --no-git-checks.
  skipFileCheck boolean  Default for --skip-file-check.
  allowSuspicious boolean Default for --allow-suspicious.

Preview modes do not test registry access, credentials or provenance eligibility.
Requires pnpm on PATH; npm as well to publish, since only the upload uses it. npm
provenance additionally requires Node.js 22.14+ and npm 11.5.1+, and only a cloud CI
runner can produce it.`;

export function parseOptions(rawArgs: readonly string[]) {
  const separator = rawArgs.indexOf("--");
  const cliArgs = separator === -1 ? rawArgs : rawArgs.slice(0, separator);
  const publishArgs = publicationArgs(separator === -1 ? [] : rawArgs.slice(separator + 1));
  const parsed = parseArgs({
    args: cliArgs,
    allowPositionals: true,
    options: {
      "allow-suspicious": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "guard-only": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      // Declared by its negative name, like `--no-git-checks`: `parseArgs` has no `--no-`
      // negation of its own and rejects the flag outright as unknown.
      "no-git-checks": { type: "boolean", default: false },
      "no-heal": { type: "boolean", default: false },
      registry: { type: "string", default: undefined },
      "skip-file-check": { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      "tarball-out": { type: "string", default: undefined },
      "verify-only": { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    strict: true,
  });

  // `verify` is a subcommand as well as a flag, because a script that cannot change shape needs
  // the flag while a person typing the command reads the verb. A directory actually named
  // `verify` is still reachable as `./verify`.
  const positionals =
    parsed.positionals[0] === "verify" ? parsed.positionals.slice(1) : parsed.positionals;
  const verify = positionals !== parsed.positionals || parsed.values["verify-only"] === true;

  return { ...parsed, positionals, publishArgs, verify };
}
