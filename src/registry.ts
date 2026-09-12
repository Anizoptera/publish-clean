/**
 * Where the package gets published TO, and nothing about what it contains.
 *
 * Split from `manifest.ts` because the consumers said so: `options.ts` needs this and nothing else
 * a manifest knows, and `config.ts` needs this plus one field vocabulary. A registry destination
 * arrives from three places that must agree — the command line, the author's `publish-clean` block,
 * and `publishConfig` inside the artifact — so the rule that judges one lives once, here.
 *
 * Ambient inputs arrive as parameters — no process, filesystem or argv here.
 */
import { PublishCleanError } from "./error";
import type { Finding } from "./finding";
import { isObject } from "./json";
import type { JsonObject } from "./json";

/** npm gives a scope registry priority over the general registry setting. */
export function packageScope(pkg: JsonObject): string | null {
  if (typeof pkg.name !== "string" || !pkg.name.startsWith("@")) return null;
  const slash = pkg.name.indexOf("/");
  return slash > 1 ? pkg.name.slice(0, slash) : null;
}

/**
 * Why a registry destination is unusable, or null when it is fine.
 *
 * Never returns, quotes or embeds the value. A registry URL is the one manifest string that
 * routinely carries a password, and an error message is the thing an author pastes into an issue
 * — so the fault is named and the value stays here. That is also why the URL parser's own
 * exception is discarded rather than chained: it retains its input.
 */
function registryFault(value: unknown): null | { readonly rule: string; readonly message: string } {
  const malformed = {
    rule: "registry-not-a-url",
    // A destination npm cannot parse is not a local typo it reports back: npm falls through to
    // its default, so the package lands on the public registry nobody chose.
    message:
      `Registry must be an absolute HTTP(S) URL. The value is withheld here because a registry ` +
      `URL commonly carries a password; read it from your own package.json.`,
  };
  if (typeof value !== "string" || !URL.canParse(value)) return malformed;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") return malformed;
  if (url.username || url.password)
    return {
      rule: "registry-credentials",
      message:
        `Registry URLs must not contain credentials. Configure npm authentication separately ` +
        `— an .npmrc auth token, or a CI secret — and leave the URL bare. Treat the credential ` +
        `in this one as compromised: it is in your package.json and was about to be published ` +
        `inside the tarball's manifest.`,
    };
  return null;
}

/**
 * A registry chosen on the COMMAND LINE. Throws, because a bad argument is not a defect in the
 * package being examined: there is nothing to accumulate it with, and every later answer would
 * be about a destination the author did not ask for.
 */
export function assertRegistry(value: unknown): asserts value is string {
  const fault = registryFault(value);
  if (fault) throw new PublishCleanError(fault.message);
}

/**
 * Every registry destination the ARTIFACT carries, reported rather than thrown.
 *
 * `harm` and never healed, so it still refuses the publish — stripping the key would hide that
 * the credential leaked into a file the author shares, and they still have to rotate it. What
 * reporting buys is the rest of the run: this sits before the whole artifact scan, so stopping
 * here used to hide every finding about the tarball instead of one line of it.
 */
export function reviewRegistryDestinations(pkg: JsonObject): Finding[] {
  if (!isObject(pkg.publishConfig)) return [];
  return Object.entries(pkg.publishConfig).flatMap(([key, value]) => {
    if (key !== "registry" && !key.endsWith(":registry")) return [];
    const fault = registryFault(value);
    if (!fault) return [];
    return [
      {
        rule: fault.rule,
        consequence: "harm" as const,
        healed: false,
        where: `publishConfig[${JSON.stringify(key)}]`,
        message: fault.message,
      },
    ];
  });
}

/**
 * Pins the published manifest to a registry, when one was chosen.
 *
 * Written into `publishConfig` rather than passed only on the command line, because that is
 * where npm looks when someone later republishes the same tarball by hand — the artifact then
 * carries its own destination instead of depending on whoever runs the command. Any other
 * `publishConfig` keys the author set are consumer-facing and survive untouched.
 *
 * Returns the manifest unchanged when no registry was chosen, so the caller has no branch and
 * cannot forget one.
 */

export function withRegistry(pkg: JsonObject, registry: null | string): JsonObject {
  if (registry === null) return pkg;
  assertRegistry(registry);
  const publishConfig = isObject(pkg.publishConfig) ? { ...pkg.publishConfig } : {};
  publishConfig.registry = registry;
  const scope = packageScope(pkg);
  if (scope) publishConfig[`${scope}:registry`] = registry;
  return { ...pkg, publishConfig };
}
