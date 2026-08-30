# statice

<img width="1200" height="500" alt="statice" src="https://github.com/user-attachments/assets/825f1ab8-cb98-46e4-90b2-693cddf84469" />

Type `statice` in a folder, get a live URL. No accounts, no project creation, no
config file.

[![ci](https://github.com/okandship/statice/actions/workflows/ci.yml/badge.svg)](https://github.com/okandship/statice/actions/workflows/ci.yml)

A content-addressed static host: the URL is a hash of the files it serves, so
it cannot be repointed and does not expire, and short names and custom domains
sit on top of that. It runs on Cloudflare Workers and R2, with a single-file
CLI, and neither side has a runtime dependency.

**Status.** Experimental, single-maintainer, and live at
[statice.run](https://statice.run) as a hosted service with hand-issued access
keys. This repository is the whole of it — the Worker, the CLI, the landing
site, the operator scripts and the design — published so that anyone using the
service can read exactly what it does, and as a piece of work in its own
right. It is not packaged as a self-hosting kit: the hostnames and routes of
the live instance are written into the code, and nothing here promises to work
anywhere else. Read it, run it, take from it;
running your own copy is possible in principle and unsupported in practice.

The design is [docs/statice.md](docs/statice.md); the CLI's own README is
[cli/README.md](cli/README.md). Contributions and reports:
[CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). The rest of
this file is how to work on it.

```
worker/     the Worker: API and serving, one entrypoint, a route per domain
cli/        the CLI, single file, no dependencies
site/       the landing page — a statice site, served by statice
            (photographs, fonts and all: everything it needs is in the folder,
            so the page is one deploy and its licences ship beside the files)
ops/        the standing habits: the export cron, the reconcile — and the
            key script, which runs when you say so and not on a schedule
docs/       the design
```

## Getting started

Node 22 or newer for the repository, since the Cloudflare tooling needs it
(`.node-version` says 24), and npm 10 or newer. The published CLI itself runs
on Node 18.

```bash
npm ci               # every workspace, from the lockfile
npm test             # Worker, CLI and parity suites
npm run typecheck    # the Worker
```

CI runs exactly that from a clean checkout on every push and pull request,
with no credentials. Deploying and publishing happen where a pull request
cannot reach and with no credential stored in the repository: Cloudflare
builds and deploys the Worker from pushes to `main`, and a `cli-v<version>`
tag publishes the CLI through npm's trusted publishing, both below.

## Branches

The maintainer works on `main` and commits straight to it. The history is
linear and single-maintainer, so a branch buys no review and costs a merge —
that goes for agents working in this tree too: do not create one, and do not
offer to. Outside changes arrive as a fork and a pull request and land the same
way, rebased and fast-forwarded; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Live

| | |
|---|---|
| landing | https://statice.run |
| api | `https://api.statice.run` — `/v1` is its entire surface |
| hash URLs | `<52-char base32>.statice.app` |
| names | `<slug>-<suffix>.statice.app` |

## Working on the Worker

```bash
cd worker && npm test
```

The tests run inside `workerd` through the real request pipeline rather than by
calling handlers, because several of the invariants are things the runtime does
to a response on its way out — `Content-Length` surviving `FixedLengthStream`
most of all.

**Keep the test runtime current.** `@cloudflare/vitest-pool-workers` pulls its
own `wrangler` and `workerd`, independently of the one used to deploy, so a
stale pin there silently tests against a runtime production does not run — which
is worthless for exactly the invariants these tests exist to hold. The
`compatibility_date` in `wrangler.jsonc` and `vitest.config.ts` must match each
other and must not exceed the pool's bundled `workerd`, since it is a claim
about the semantics the code was *tested* against.

The resolver is mocked through miniflare's `outboundService` rather than by
intercepting a global: `SELF.fetch` runs the Worker as a separate instance, so
`outboundService` is where its egress actually goes. The mock is stateless and
keyed on the queried name — the suffix picks the answer and the first DNS label
*is* the label the proof names, so a host built as `<label>.owned.example`
proves itself with no shared state to coordinate.

Every entry in the design's **Gotchas worth a test** has a test. They are marked
with the sentence from the doc that they hold up, so a failure names the thing it
broke rather than the assertion that noticed.

```bash
cd worker && npx tsc --noEmit    # typecheck
```

A push to `main` that touches `worker/`, `package.json` or `package-lock.json`
is the deploy. Cloudflare's Workers Builds is connected to this repository and
pulls it through its own GitHub App, so no Cloudflare token exists on the
GitHub side. Its build command runs the typecheck, the Worker tests and the
parity test from a clean install, and its deploy command is `npm run deploy -w
worker`, which is `wrangler deploy` with the routes from `wrangler.jsonc`.
Those two commands and the watch paths are dashboard settings, not files here;
the build log and every deployed version are under the Worker in the
Cloudflare dashboard. `npx wrangler deploy` from `worker/` does the same thing
by hand if the build is ever the problem.

Two things `wrangler dev` cannot prove, so both are verified against production
before the code that leans on them: **R2's conditional put** (the slug claim
ladder) and **its `sha256` refusal** (the blob route, which must tell a corrupt
upload apart from R2 being down).

**The dependency advisory, and why it stands.** `npm audit` names `sharp`
through `miniflare`, which every current Wrangler and test-pool release still
pins below the fixed version. The root `package.json` overrides it to the fixed
`0.35.4`, which the test suite validates on every run; the library is
miniflare's image-binding emulation and is never reached by this project's
tests, and neither the deployed Worker nor the CLI has a runtime dependency at
all. Drop the override once the tooling catches up.

## Working on the CLI

```bash
cd cli && npm link          # `statice` on PATH, symlinked to this working tree
cd cli && npm test          # node's built-in runner, no dependencies
```

`npm link` points at the working tree, so edits take effect on the next
invocation with nothing to reinstall — and it exercises the same `bin` entry
`npm publish` will, so a working link is a rehearsal for the publish. It is also
live in the bad direction: a broken edit breaks `statice` everywhere at once, so
`node --check cli/statice.mjs` is the cheap guard. Undo with `npm unlink -g @statice/cli`.

The tests run the real binary as a subprocess against a stub API, because the
things worth holding are what the process **refuses** to do and what bytes it
puts on the wire — neither visible to a test that imports functions. Note that
the stub must be driven with async `spawn`: `spawnSync` blocks the event loop
the stub server runs in, and the child's request can never be served.

### The package is `@statice/cli`; the command is `statice`

The bare `statice` name on npm is an abandoned `0.0.0` from 2015 with **no
`bin`**, so there is no command collision — the installed binary is `statice`
either way. The scope was chosen over `statice-run` or a personal scope because
it reserves the whole `@statice` namespace, which is worth more than the one
squatted package. Scoped packages default to private, so `publishConfig.access`
is set to `public`.

**Releasing.** The version lives in `cli/package.json` alone — `--version`
reads it, and a test holds the two equal. Bump it, commit, then tag the commit
`cli-v<version>` and push the tag. The `release` workflow checks that the tag
and the file agree, runs the suite, checks the pack is exactly four files, and
publishes with provenance, so the package page shows the commit it was built
from. There is no npm token in the repository: npm trusts this repository's
identity for that one workflow file.

### The type table

The type table in `cli/statice.mjs` is **mirrored byte-for-byte** from
`worker/src/type-table.ts`. It is frozen in both directions: the CLI admits
files by it, so it decides which files a folder *has*, and the selection policy
is an input to the root. Widening either copy alone mints new URLs from
unchanged bytes with nothing detecting it.

## Deploying the landing page

It is a statice site like any other, reached through `domains/statice.run`:

```bash
cd site && node ../cli/statice.mjs
```

## Ops

```bash
# the two prefixes a redeploy cannot reconstruct; token scoped Object Read-only
R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... node ops/export.mjs

# billing reconciliation for multi-tenant custom hostnames; inert until SaaS is on
CF_API_TOKEN=... CF_ZONE_ID=... node ops/reconcile.mjs        # --apply to act
```

Neither can delete content. `export.mjs` is a `list` and a copy; `reconcile.mjs`
touches custom hostnames and never an R2 object.

Access keys are issued by hand, and `ops/keys.mjs` is the hand:

```bash
node ops/keys.mjs issue alice   # mint, add to KEY_HASHES, probe it, print the key
```

The roster the secret is rebuilt from — a Worker secret is write-only, so
nothing else knows the whole set — is an append-only log of holder names and
SHA-256 digests. It is not in this repository: it names people, and a copy
synced by anyone else would admit them to that instance. `keys.mjs` reads it
from `~/.statice-ops/keys` (`STATICE_ROSTER` overrides), beside the Cloudflare
token and account id it also needs. The scripts default to the live Worker and
API; they are the operator's tools, not a template.

## Licences

The code is MIT ([LICENSE](LICENSE); [cli/LICENSE](cli/LICENSE) ships in the
package). Two things in `site/` are not the project's to relicense, and travel
under their own terms beside the files rather than under the MIT grant: the
photographs in `site/img/`, from Unsplash under the
[Unsplash License](https://unsplash.com/license) and credited in
[site/img/CREDITS.txt](site/img/CREDITS.txt); and the typeface in
`site/fonts/`, JetBrains Mono under the SIL Open Font License 1.1, whose text
is [site/fonts/OFL.txt](site/fonts/OFL.txt).
