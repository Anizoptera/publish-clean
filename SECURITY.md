# Security

Report vulnerabilities through [GitHub private reporting](https://github.com/Anizoptera/publish-clean/security/advisories/new).
Keep unpatched vulnerabilities, secrets and working exploits out of public issues.

Security fixes go to the latest released version. Older versions are not patched.

## What this tool is responsible for

`publish-clean` checks file paths and cleans the published manifest. Report bypasses of
those checks or failures to remove development-only manifest data. File checks do not
scan contents for embedded credentials.

Releases are published from GitHub Actions with npm provenance. Verify signatures and
provenance for installed dependencies with:

```bash
npm audit signatures
```
