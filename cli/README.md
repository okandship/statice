# statice

Type `statice` in a folder, get a live URL. No accounts, no project creation, no
config file.

```bash
npx @statice/cli
```

Nothing to install. The package is `@statice/cli`; the command inside it is
`statice`, so the examples below write `statice` for brevity — read it as
`npx @statice/cli` throughout.

## A key first

Keys are issued by hand. Email access@statice.run to get one, then store it on
this machine:

```bash
statice key
```

It prompts for the key, or reads it from stdin if you pipe one in, and writes
`~/.statice/key`. It prints the key's SHA-256 as it writes, so you can check the
one you stored is the one you were given.

## Deploy

```bash
statice
```

The folder goes up as it is and comes back as a hash URL — 52 base32 characters
derived from the content, so the same bytes always land on the same URL.

**There is no unpublish, and hash URLs are permanent.** Deploy something you
don't mind being permanent.

For a short name instead of a hash:

```bash
statice --name "my thing"
```

That claims the name, or updates it if you already hold it, and writes a
`.statice` file in the folder recording the label. The `.statice` file is public
— commit it if you like. The *token* that proves you own the name is written to
`~/.statice/slugs/<label>`, and losing it loses the name permanently.

## Commands

| | |
|---|---|
| `statice` | deploy this folder to a hash URL |
| `statice --name "my thing"` | deploy, then claim or update a short name |
| `statice --name` | same, named after this folder |
| `statice --isolated` | add the cross-origin isolation marker, then deploy |
| `statice --verify` | re-upload every blob, then deploy (the way back) |
| `statice --dry-run` | list what would be published, and stop |
| `statice key` | store this machine's access key |
| `statice claim <label>` | adopt a name on a second machine |
| `statice names` | every label with a token, and its folder |
| `statice retire [label]` | take a label out of service |
| `statice domain <host>` | bind a custom domain to this folder's name |
| `statice domain rm <host>` | unbind it |

`statice --help` prints the same list. A flag it does not know is a refusal,
not a deploy.

## What goes up

Everything in the folder with an admitted extension — HTML, CSS, JS, JSON,
wasm, images, fonts, media, PDF, text, Markdown and a few more — minus `.git`,
`node_modules`, dot-directories and symlinks. It does **not** read
`.gitignore`, and it drops dot-*directories*, not dot-*files*: `.env.local.json`
has an admitted extension and goes up like anything else. Source in admitted
types, sourcemaps and documents go up too. The first deploy from a folder
shows the list before it asks; `statice --dry-run` shows it and stops, with no
key and no network.

## Retiring and reviving a name

`statice retire` tombstones the label — it 404s, and nobody else can claim it —
and keeps the token on this machine. To bring it back, `statice claim <label>`
restores the `.statice` pointer from that token, and the next deploy updates
the name. Deploying with `--name` instead would make a *new* claim under a
fresh suffix.

## Files it touches

| | |
|---|---|
| `.statice` | the label, in the folder you deploy. Public. |
| `~/.statice/key` | the access key. One per machine. |
| `~/.statice/slugs/<label>` | the token. Losing it loses the name, permanently. |
| `~/.statice/deployed` | a log of every deploy from this machine: time, root, folder. |

## Environment

| | |
|---|---|
| `STATICE_KEY` | use this access key instead of the stored one |
| `STATICE_TOKEN` | use this name token instead of the stored one |
| `STATICE_API` | point at a different API (default `https://api.statice.run`). HTTPS, or plain http on a loopback address only — the key rides on every call. |

Exit codes: `0` when what was asked for happened, `1` otherwise. A bare
`statice` that deployed but could not update its name still exits `0`, since the
deploy is what it was asked for; `statice --name` in the same situation exits
`1`. A first deploy with no terminal attached prints its listing and proceeds
without asking.

## Requirements

Node 18 or newer. One file, no dependencies.

## Source and reports

The CLI, the Worker it talks to and the design are at
<https://github.com/okandship/statice>. Bugs go to the issue tracker there;
security reports follow the `SECURITY.md` in that repository.

## License

MIT
