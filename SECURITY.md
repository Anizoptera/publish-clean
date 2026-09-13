# Security

Report vulnerabilities through [GitHub private reporting](https://github.com/Anizoptera/publish-clean/security/advisories/new).
Keep unpatched vulnerabilities, secrets and working exploits out of public issues.

Security fixes go to the latest released version. Older versions are not patched.

## What this tool is responsible for

`publish-clean` decides what the published tarball carries and rewrites its manifest.

In scope: a secret or development file that reaches the tarball anyway, a check that can be
bypassed, a manifest rewrite that changes what any RUNTIME resolves, and anything that makes
the published bytes differ from the bytes that were checked.

Two things are deliberate and are not bugs. The `types` repair does change what a type
checker resolves — that is its purpose, and only a checker reads those keys. And secrets are
matched by FILE NAME — `.env`, `.npmrc`, key and keystore extensions, SSH key names — so a
credential hardcoded inside a source file is published with nothing reported. Scanning file
contents for secrets is a different tool's job.

Releases are published from GitHub Actions with npm provenance. Verify signatures and
provenance for installed dependencies with:

```bash
npm audit signatures
```
