/**
 * Who npm will believe is publishing, and what the toolchain must be for it to sign anything.
 *
 * Ambient inputs arrive as parameters and never by reaching for them — no process, filesystem or
 * argv here. `cli.ts` owns the effects.
 */
import { PublishCleanError } from "./error";
import { isObject } from "./json";
import type { JsonObject } from "./json";

/**
 * The floors npm's trusted publishing puts on the toolchain, each formatted into its own error
 * message so the version a reader is told to install is the version the comparison made.
 *
 * These floors apply to trusted publication; ordinary token-based publication can use the
 * lower Node floor declared by engines.node.
 */
export const MIN_TRUSTED_NPM_VERSION = [11, 5, 1] as const;
export const MIN_TRUSTED_NODE_VERSION = [22, 14, 0] as const;

export function isAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (const index of [0, 1, 2] as const) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

/**
 * The exact variables the publish decisions read, named so the dependency is visible in each
 * signature instead of reaching into the ambient process from a module that promises not to.
 * `process.env` satisfies this structurally, so the caller passes it and nothing else changes.
 */
export interface TrustedPublishEnv {
  ACTIONS_ID_TOKEN_REQUEST_URL?: string | undefined;
  GITHUB_ACTIONS?: string | undefined;
  GITHUB_REPOSITORY?: string | undefined;
}

export function wantsTrustedPublish(
  pkg: JsonObject,
  publishArgs: readonly string[],
  env: TrustedPublishEnv,
): boolean {
  // OIDC authentication requires the trusted runtime even when attestation is disabled.
  return (
    provenanceIntent(pkg, publishArgs) === true ||
    (env.GITHUB_ACTIONS === "true" && typeof env.ACTIONS_ID_TOKEN_REQUEST_URL === "string")
  );
}

/** CLI overrides the manifest; undefined delegates to npm's own configuration resolver. */
export function provenanceIntent(
  pkg: JsonObject,
  publishArgs: readonly string[],
): boolean | undefined {
  for (let index = publishArgs.length - 1; index >= 0; index--) {
    if (publishArgs[index] === "--provenance=true" || publishArgs[index] === "--provenance")
      return true;
    if (publishArgs[index] === "--provenance=false") return false;
  }
  if (isObject(pkg.publishConfig) && pkg.publishConfig.provenance !== undefined)
    return Boolean(pkg.publishConfig.provenance);
  return undefined;
}

export function repositoryUrl(pkg: JsonObject): null | string {
  if (typeof pkg.repository === "string") return pkg.repository;
  if (isObject(pkg.repository) && typeof pkg.repository.url === "string") return pkg.repository.url;
  return null;
}

export function githubRepositorySlug(url: string): null | string {
  const withoutGitPrefix = url.startsWith("git+") ? url.slice(4) : url;
  if (withoutGitPrefix.startsWith("git@github.com:")) {
    const slug = withoutGitPrefix.slice("git@github.com:".length);
    return slug.endsWith(".git") ? slug.slice(0, -4) : slug;
  }
  try {
    const parsed = new URL(withoutGitPrefix);
    if (parsed.hostname !== "github.com") return null;
    const slug = parsed.pathname.replace(/^\/+/, "");
    return slug.endsWith(".git") ? slug.slice(0, -4) : slug;
  } catch {
    return null;
  }
}

export function assertRepositoryForTrustedPublish(
  pkg: JsonObject,
  publishArgs: readonly string[],
  env: TrustedPublishEnv,
): void {
  if (!wantsTrustedPublish(pkg, publishArgs, env)) return;
  if (env.GITHUB_ACTIONS !== "true" || typeof env.GITHUB_REPOSITORY !== "string") return;
  const repoUrl = repositoryUrl(pkg);
  if (!repoUrl)
    throw new PublishCleanError(
      "GitHub trusted publishing requires package.json repository.url to match GITHUB_REPOSITORY.",
    );
  const slug = githubRepositorySlug(repoUrl);
  if (slug !== env.GITHUB_REPOSITORY)
    throw new PublishCleanError(
      `package.json repository.url must match GITHUB_REPOSITORY (${env.GITHUB_REPOSITORY}); found ${repoUrl}.`,
    );
}
