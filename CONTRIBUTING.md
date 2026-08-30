# Contributing

statice is a single-maintainer project published so that the people who use the
hosted service can read what it does. Bug reports and small, well-aimed pull
requests are welcome; large changes are better opened as an issue first, since
much of what looks like an omission is a decision recorded in
[docs/statice.md](docs/statice.md).

## Setup

Node 22 or newer (`.node-version` says 24), npm 10 or newer.

```bash
npm ci               # every workspace, from the lockfile
npm test             # Worker, CLI and parity suites
npm run typecheck    # the Worker
```

The Worker tests run inside `workerd`; the CLI tests run the real binary as a
subprocess against a stub API. Both are described in the [README](README.md).

## How changes land

The maintainer works on `main` and commits straight to it. Outside changes come
as a fork and a pull request, and are landed the same way — rebased and
fast-forwarded, so `main` stays linear. The test workflow runs from a clean
install on every pull request and holds no credentials. The Worker deploys
from Cloudflare's own build of `main`, and the CLI publishes from a tag through
the release workflow, so nothing a pull request runs can deploy the Worker or
publish the CLI.

## What is frozen

Two things are compatibility contracts, and a pull request that touches either
needs to say why:

- **The manifest format and the root.** The canonical path rules, the
  serialization `<hash> <path>\n` sorted by UTF-8 bytes, and the SHA-256 over
  those bytes. Changing any of it mints different URLs for unchanged folders.
- **The type table.** It exists twice, in `worker/src/type-table.ts` and in
  `cli/statice.mjs`, and it is an input to the root: the CLI admits files by
  it, so it decides which files a folder *has*. The parity test holds the two
  copies equal, and widening it is a protocol change, not a convenience.

The other rules worth knowing before editing: the Worker computes the root and
never accepts one from a client; the access key is admission and never
identity; and nothing deletes on a timer.

## Reporting

Security issues go through [SECURITY.md](SECURITY.md), not the issue tracker.
