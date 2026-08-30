# Security

## Reporting a vulnerability

Email **access@statice.run** with `security` in the subject line. Please do
not open a public issue for anything that could be exploited before it is
fixed.

This is a single-maintainer project. Reports get a reply as soon as the
maintainer reads them, and a fix on a best-effort schedule with no promised
window. Coordinated disclosure is welcome; just say what timeline you have in
mind.

## What is in scope

- The Worker (`worker/`): the `/v1` API and the serving path.
- The CLI (`cli/`, published as `@statice/cli`): what it reads, writes and
  sends.
- The operator scripts (`ops/`).

Things that are documented limitations rather than vulnerabilities, and known:
`statice.app` is one cookie domain until it is on the Public Suffix List; a
holder of an access key can fill storage, since the key is admission and not a
quota; a name's token has no rotation, so a leaked token is a lost name. The
design document ([docs/statice.md](docs/statice.md)) states these plainly.

## Abuse of hosted content

Content served from `*.statice.app` or a bound domain is published by whoever
holds a key, not by the project. To report phishing, malware or other abuse on a
statice-hosted site, email the same address with `abuse` in the subject line and
the URL. Takedown is an operator action and is treated as urgent.

## Supported versions

The latest published `@statice/cli` and the current `main` of this repository.
Older CLI versions are not patched; `npx @statice/cli` always runs the latest.
