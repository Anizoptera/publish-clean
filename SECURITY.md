# Security

Report a vulnerability through GitHub private vulnerability reporting:

https://github.com/Anizoptera/publish-clean/security/advisories/new

Private reporting is enabled on this repository, so use it. Do not open a public issue
for anything unpatched, and keep secrets and working exploit details out of public
threads.

Security fixes go to the latest released version. Older versions are not patched.

## What this tool is responsible for

`publish-clean` decides what ends up in a published npm tarball, so a bug here can put a
file on a public registry that was never meant to leave your machine. Reports about the
leak checks failing to catch something, or about the cleaned manifest keeping data it
should have removed, are in scope and worth reporting privately.

Releases are published from GitHub Actions with npm provenance. You can check that any
version you installed came from this repository:

```bash
npm audit signatures
```
