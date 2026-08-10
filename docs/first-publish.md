# Publishing a package name for the first time

You cannot configure trusted publishing for a package that does not exist yet. It works
by attaching a publisher to a package record, and a name nobody has published has no
record to attach to. `npm trust` and staged publishing hit the same wall for the same
reason: all three are ways of authorising a publisher, and all three need something to
authorise against. PyPI solves this with pending publishers. npm has nothing equivalent.

So every package name gets exactly one release that authenticates with a token. Once,
and never again.

Do that release from CI, not from your laptop. npm only generates provenance on a
supported cloud runner, so a hand-published first version stays unsigned for as long as
it exists, and the only way to fix it is to publish another version.

## Steps

1. Create a granular access token scoped to your package or scope, with read and write
   permission and the shortest expiry npm offers. Tick the option to bypass 2FA for
   package publishing. Without it the publish gets all the way to the registry, mints its
   provenance, and is then rejected with `EOTP`, asking for a one-time password that no
   unattended build can produce.
2. Store it as an Actions secret and pass it to the publish step as `NODE_AUTH_TOKEN`.
   Keep `id-token: write` on the job: npm mints provenance from the OIDC identity even
   when the token is what authenticates.
3. Run the release. Verify with `npm audit signatures`, or read `dist.attestations` from
   the version document (`registry.npmjs.org/<name>/<version>`). Check the version
   document, not the package-level one. If you looked the package up while it did not
   exist yet, the CDN may still be serving you your own cached 404.
4. Configure the trusted publisher on npmjs.com, naming the repository and the workflow
   filename. npm keys the trust on that filename, so renaming or moving the workflow later
   breaks publishing, and the error will not mention the rename. This step needs
   interactive 2FA. Tokens that bypass 2FA have been barred from package management since
   August 2026.
5. Delete the Actions secret and revoke the token. Later releases authenticate with the
   OIDC identity alone.

Delete the secret rather than leaving it in place. While it exists, a misconfigured
trusted publisher is silently papered over by the token, and you find out only on the day
you remove it.

## Known expiry

npm is removing direct publishing from 2FA-bypassing tokens in January 2027. The
documented replacement, staged publishing, needs an existing package too, so what the
first publish looks like after that date is genuinely unclear.
