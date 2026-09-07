# Publishing a package name for the first time

Publish the first version from CI with a short-lived token, then configure trusted
publishing for later releases. npm attaches trusted publishers to an existing package.

Use a supported cloud runner so the first version has provenance. Provenance cannot be
added to an already published version; that requires a new release.

## Steps

1. Create a granular access token scoped to your package or scope, with read and write
   permission and the shortest expiry npm offers. Tick the option to bypass 2FA for
   package publishing. Without it, an unattended publish fails with `EOTP` because it
   cannot supply a one-time password.
2. Store it as an Actions secret and pass it to the publish step as `NODE_AUTH_TOKEN`.
   Keep `id-token: write` on the job: npm mints provenance from the OIDC identity even
   when the token is what authenticates.
3. Run the release. Verify with `npm audit signatures`, or read `dist.attestations` from
   the version document (`registry.npmjs.org/<name>/<version>`). Check the version
   document, not the package-level one. If you looked the package up while it did not
   exist yet, the CDN may still be serving you your own cached 404.
4. Configure the trusted publisher on npmjs.com, naming the repository and the workflow
   filename, and permit direct `npm publish`. New connections default to staged publishing.
   Keep the configured filename when editing the workflow, or update the trusted publisher.
   Managing the connection requires interactive 2FA; a token that bypasses 2FA cannot do it.
5. Delete the Actions secret and revoke the token. Later releases authenticate with the
   OIDC identity alone.

Remove the token so it cannot hide a broken OIDC configuration by authenticating instead.
See [npm's trusted publishing setup](https://docs.npmjs.com/trusted-publishers/).

## Token publishing is being phased out

npm [plans to remove direct publishing from 2FA-bypassing tokens around January 2027](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/).
Check the current npm setup before using this token-based first-release procedure after
that change. The announcement does not specify a replacement for this first-release flow.
