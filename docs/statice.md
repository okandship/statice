# statice

Type `statice` in a folder, get a live URL. No accounts, no project creation, no
config file. Three layers, each usable alone:

| layer | you get | address |
|---|---|---|
| 1 | a hash URL | `q4mfcytc4jz…4h5a.statice.app` |
| 2 | a name you pick | `cool-3d-generator-hfj.statice.app` |
| 3 | your own domain | `app.example.com` |

Everything is content-addressed: a URL is a hash of the bytes it serves, so
nothing can be repointed and nothing needs authorizing. Layers 2 and 3 add one
kind of mutable pointer between them — layer 3 points at layer 2's rather than
inventing a second.

**Goals.** (1) `statice` in a folder → live URL in ~3 seconds. (2) Redeploy
unchanged → nothing uploaded, same URL. (3) Change one file → only that file
uploaded, **new URL**, old URL still serving. (4) No accounts, no config.

**Stack.** One Worker: API and serving, one entrypoint, a route per domain. One
private R2 bucket via binding. Wildcard DNS + TLS on `*.statice.app`,
`api.statice.run` for the API, the `statice.run` apex for the landing page.
Single-file CLI. **No server-side cache**, with one layer-2 exception over
content-addressed keys that cannot go stale.

```
blobs/<sha256-hex>       file bytes, no Content-Type
manifests/<root-hex>     manifest text
slugs/<label>            <root: 64 hex> <auth: 64 hex>\n     layer 2
domains/<host>           <label>\n                           layer 3
```

That is the whole persistence layer — no database, no sessions, no aliases. For
the first two prefixes, **the key is the SHA-256 of the bytes under it**, so
overwrite-on-put is harmless and dedup is free across every tenant. Listing
`manifests/` is every site there is.

---

# Layer 1 — hash URLs

## The manifest

Sorted UTF-8 text, one line per file, newline-terminated. `root` = SHA-256 of
exactly those bytes; the fixed-width prefix lets readers slice at byte 65.

```
<sha256-hex> <path>\n
```

Sorted by path, strictly ascending, comparing **UTF-8 bytes**. **Reject, never
repair** — the governing rule for every client field in the system. Paths arrive
NFC, `/`-separated, leading `/`; refused rather than folded are non-NFC,
`\n`/`\r`/NUL/`\`, unpaired surrogates, `.`/`..`/empty segments, `//`, a trailing
`/`, and anything over 1,024 bytes. **Freeze the encoding once the first real
link is shared.**

**The walk is part of the root.** The root hashes *the entries the CLI chose to
put in the manifest*, chosen by five client-side rules: the type table; the prune
list (`.git`, `node_modules`, dotdirs except a top-level `.well-known`); skipped
symlinks; the agent instruction files (`CLAUDE.md`, `AGENTS.md`, case-folded, at
every depth); path canonicalization. Only the last is held on both sides, so widening
any of the others mints new URLs from unchanged bytes with nothing detecting it.
**`root = f(bytes, selection policy)`, and the policy is frozen as hard as the
encoding.**

## Addressing

Label = the root in **base32**, lowercase, unpadded: 256 bits → 52 chars, forced
because hex is 64 and a DNS label caps at 63. R2 keys stay hex. **Non-canonical
labels 404**: decode, re-encode, compare byte-for-byte. The `statice.app` apex
301s to `https://statice.run`, never `immutable`; any other non-conforming label
404s.

## Access

**One key, `Authorization: Bearer`, on every `/v1/` request — and the API has its
own host.** `/v1/` is `api.statice.run`'s entire surface, and nothing on
`statice.app` ever asks for a key, so a request is API or content by the time
`Host` is read.

The key is **admission, not identity**: validate and discard, so nothing records
which key wrote what and the gate stays removable. Validation is a set of
`SHA256(key)` in **one** secret, `KEY_HASHES`, comma-separated hex — the shape
rotation operates on — and **empty or missing fails closed**. `statice key` takes
no argument, prompting or reading stdin, and **prints the digest as it writes
`~/.statice/key`**, which is `0700` with `0600` files, set at creation.

## Validation

Every client field is checked against a stated shape before use, on every
endpoint — all string tests, all before the first R2 operation.

| field | shape |
|---|---|
| hash | `^[0-9a-f]{64}$` |
| path | manifest canonicalization, then the type table |
| size | integer `0 … 64 MB`; one size per hash, agreeing everywhere; summed over **distinct** hashes ≤ 512 MB |
| `files` | object, 1–1,000 entries, each value a `[hash, size]` pair |
| `base` | absent, or `^[0-9a-f]{64}$`; a shape failure rejects, a root that does not resolve is absent |
| body — deploy | `Content-Length` present, `^[0-9]+$`, ≤ 8 MB, **read before the parse** |
| body — blob PUT | same, `0 … 64 MB`; SHA-256 equal to the key, enforced by R2 |
| `Authorization` | `Bearer` + one space + key; scheme **case-insensitive**; remainder hashed, never trimmed |
| `label` / `auth` / `X-Statice-Token` | `^[a-z0-9-]{1,63}$` / `^[0-9a-f]{64}$` / `^[0-9a-f]{64}$` |
| `host` | see [Binding](#binding) |

Two deliberate exceptions to *reject, never repair*, safe because they fold
nothing stored: the type table's lowercased **extension** and layer 3's
lowercased **host**.

## What `/v1` answers

Every `/v1` response with a body is JSON: `{ "error": "<code>", "message": "…" }`.
Success bodies never carry `error`, so `"error" in body` is the whole test.

| status | when | `error` |
|---|---|---|
| 200 | deploy, `deployed` or `incomplete` | — |
| 201 / 202 / 204 | blob PUT and slug claim / domain bind / slug update, delete, check and domain unbind | — |
| 400 / 401 | validation failure / missing, malformed or unknown key, token mismatch | `invalid-request`, `unauthorized` |
| 404 / 405 | no such route, label with no record / wrong method, carrying `Allow` | `not-found`, `method-not-allowed` |
| 411 / 413 | `Content-Length` absent / over cap | `length-required`, `too-large` |
| 422 / 502 / 503 | shape fine but the world disagrees / R2 threw / exhausted ladder, contended record, unknown DoH | `conflict`, `upstream`, `unavailable` |

The success column is total, so a later endpoint chooses a row rather than
inventing a status. Every `/v1` response carries **`Cache-Control: no-store`**,
and never an HTML body.

## Deploy protocol

```
POST /v1/deploy
→ { "files": { "/index.html": ["<sha256>", 4096], "/style.css": ["<sha256>", 812] },
    "base": "<sha256>" }                      optional, advisory, never authority
← { "status":"incomplete", "root":"…", "url":"https://<b32>.statice.app",
    "missing":["<sha256>"] }
← { "status":"deployed",   "root":"…", "url":"https://<b32>.statice.app" }
```

**The call is self-contained** — nothing binds one call to the next, and `base`
does not change that. It names a *root*, not a prior call; it is checked against
R2 rather than believed; and dropping it changes speed and nothing else.
**Self-contained means no call depends on another having happened, not that none
may carry a hint about the world.**

1. **Shape pass, zero I/O.** Any failure rejects the whole request.
2. **Canonicalize, serialize once, hash those bytes** → `root`. **The server
   computes it; a client-supplied root is never accepted.**
3. **`head manifests/<root>`. If it exists, answer `deployed` and stop** — one R2
   operation, no blob checks, and no manifest rewrite. That key existing is proof
   this exact byte-set completed a deploy, so every blob was present at that
   moment and the caps already ran against it, with the reach **Caps** concedes
   below. This is the common path: an unchanged redeploy, and a revert.
4. Otherwise, **if `base` was sent and `manifests/<base>` reads, subtract every
   hash it lists** — one `get` against a content-addressed key. The proof that
   carries is **presence, and presence only**: that manifest existing means the
   manifest invariant held for it, so every hash it names was uploaded. This
   call's declared sizes for subtracted hashes go unchecked — they skip step 5,
   and what that spends is priced under **Caps**. A `base` that is absent,
   unknown or unreadable is simply not there: fall through whole, one wasted
   read.
5. **One head sweep** over the distinct hashes that remain, deduplicated, **width
   6**. `head()` returns presence *and* size, so a stored size contradicting the
   declaration is caught here. **Presence is non-null, never a truthy size.**
6. Anything missing → `incomplete` with the list, **nothing written**. Nothing
   missing → write the canonical bytes to `manifests/<root>` → `deployed`.

**What steps 3 and 4 give up is deletion detection** — the same thing twice, in
the same direction, on the same proof, which is why the second adds no new
category of exposure. Both read a manifest's existence as proof its blobs were
uploaded, which is exactly what the invariant promises and all it promises, and
neither notices an operator having removed one since. That is deliberate. An
operator can still delete a blob by hand, and a redeploy no
longer notices or repairs it — which is the point, since the one deletion anybody
performs on purpose is a takedown, and a redeploy that silently undid it was the
old design arguing with itself. **`statice --verify` skips both shortcuts and
sweeps every hash**, and is the way back when a site genuinely looks broken.

`PUT /v1/blobs/<sha256>`, one per missing hash: `Content-Length` first, before the
body is touched, then **the body streamed straight into `put()` with the key as
its `sha256` option** — R2 refuses a mismatch and writes nothing, the refusal is
answered as the 400 it is rather than surfacing as the catch-all's 502, and the
Worker never holds the bytes ([Gotchas](#gotchas-worth-a-test)).

```
for attempt in 1, 2, 3:
    r = POST /v1/deploy          # the same body, byte for byte, every time
    if r.status == "deployed": print r.url; exit 0
    if "error" in r and r.error != "upstream": fail, naming it; exit 1
    if attempt < 3: PUT each r.missing       # empty when the answer was upstream

fail, naming what the last answer said       # never a url for a site that is not there
exit 1
```

Both branches carry a `url`, so the exit is explicit, and **the third attempt
uploads nothing** — with no GC, bytes uploaded for a deploy that never lands are
permanent. **The loop retries `incomplete`, and beside it only `upstream`** —
`"error" in body` is already the whole test, and every other error is
deterministic on a body that never changes, so asking again is asking louder; a
timed-out call is `upstream` from where the client sits, an attempt spent. **A
failed blob PUT does not abort its round** — the other uploads still count, and
the next deploy call is the arbiter of what is missing, so nothing tracks
per-PUT outcomes. **There is no third answer**, nothing meaning *stop* — errors
refuse the question rather than answering it — which is what makes layer 2's
unconditional slug update safe.

**Caps.** `64 MB = 2²⁶` a blob, `512 MB = 2²⁹` a deploy. **The blob cap is sized
by the isolation marker's own audience** — ffmpeg's core wasm runs ~31 MB and a
Godot export ~43, and a feature that names those builds as its purpose must fit
them whole — and bounded above by the zone's 100 MB request-body ceiling, under
which it sits far enough that an oversized body still meets *our* 413. The
same number is the byte width of the fill primitive. **512 MB sums distinct
hashes; 1,000 counts entries**, and
**one hash carries one size, with two declarations required to agree** — all
checked in step 1, ahead of every byte, which is what having sizes on the wire
buys. Step 1 checks the *declaration*, and **storage confirms it only for the
hashes step 5 sweeps** — a deploy under-declaring its `base`-covered hashes is
never caught, so **512 MB binds the swept bytes, and the hard ceiling is
structural: 1,000 entries × 64 MB.** Accepted, because the lie buys nothing the
fill primitive was not already selling: a subtracted hash is a stored hash, so
no byte is new, and serving bills per blob, never per site. Closing it would
mean heading the hashes step 4 exists not to head, or sizes in the manifest — a
format change spent where the entry count already holds the ceiling. The
manifest holds hashes and paths, never sizes, so it still runs ~100 KB for a
real site and **~1.04 MiB at the bound**, which is what layer 2's cache is
sized against.

**The manifest invariant**: every hash is swept before the manifest naming it is
written, so **no manifest references a blob that was never uploaded**. With step
4 that holds **by induction rather than directly** — a subtracted hash was swept
before `base` was written, and `base` before *its* base — and the induction is
what the invariant has to be strong enough to carry, since it is also what step 4
spends. It is about *uploads* only: an operator can take a blob out from under a
manifest at any time, which is why serving answers a blob miss with a 404 and
never a 500.

**Concurrency.** The head sweep fans out at **width 6, the runtime's number and
not a choice**, a Worker being limited to six connections simultaneously awaiting
response headers. **1,000 heads at width 6 is ~167 serial rounds of bucket
latency, paid twice on a deploy that uploads**, so **the only lever is distance** —
Smart Placement is what makes the deploy path work, not an optimization.

**Steps 3 and 4 exist to make the cost proportional to the change rather than to
the tree.** An unchanged redeploy is one operation; a one-file change in a
1,000-file site is **seven R2 operations across the two rounds** — the root
`head`, the `base` `get` and one sweep `head` in each, plus the manifest write,
the blob's own PUT riding beside them — **against ~334 rounds of latency without
the hint.** What
still pays in full is a genuinely new tree, which has no `base` to name and
should not: **goal 1 holds at 50 files, and at the entry cap only for a tree
already largely uploaded.** Deploy carries an explicit **120-second client
timeout**, since Workers cap CPU rather than wall-clock; **blob PUTs get a stall
timeout instead of a deadline**, 64 MB on a home uplink being legitimate
minutes.

## Orphans

**There is no garbage collector**, and the design is easier to hold without one:
nothing deletes on a timer, so no blob vanishes from under a live manifest except
by an operator's hand. It also collected less than it looks — manifests are never
deleted, so every blob a manifest ever referenced stays live regardless, and
`style.css` from three builds ago is not garbage. The only uncollected bytes are
ones **uploaded and never referenced by any manifest**: abandoned deploys, and
deliberate fill.

Which is the cost, stated plainly. **`PUT /v1/blobs/` is an unbounded,
unattributable storage-fill primitive** for anyone holding a key — keys are
validated and discarded, so nothing ties a byte to its uploader — and with no
sweep, **nothing bounds the total.** The rate limit bounds the rate, and it
ratchets: storage only ever goes up. At one tenant that number is zero, which is
what makes this affordable now, and the **billing alert is the sensor rather
than a backstop**. `missing` is also an existence oracle,
behind the key. And the 512 MB cap is a cap on *declared* sizes: hashes a
`base` manifest already carries are subtracted before the head sweep, so their
sizes are never checked against storage, and a key holder who understates them
is bounded per upload by the blob cap and per deploy by nothing. Same holder,
same trust: the key is admission.

The escalation, if a number ever says so, is prevention rather than cleanup:
**signed per-hash upload tickets** from the deploy call, HMAC over hash and
expiry, no state — at the price of binding calls this protocol deliberately
leaves unbound. Don't, until it does.

## The type table

One table, extension → Content-Type **and an optional flag**, three uses:
**admission at deploy, Content-Type at serve, a name at review** — lists that
must agree are one list. The extension is
lowercased for the lookup and the path never is, and text types carry
`; charset=utf-8` **in the table's value**, so the charset is data, not a branch.

Admitted: `.html`/`.htm`, css, js/mjs, json, wasm — with `.pck` and `.data`
beside it as `application/octet-stream`, the bundles a Godot or Unity export is
nothing without, inert as documents under `nosniff` — the image set (`.ico`
named explicitly), the font set, the media set, pdf, txt, xml, svg, webmanifest,
vtt, md, `.obj` — geometry an OBJ loader fetches by the name the manifest
carries, so excluding it publishes a scene with nothing in it — and `.map`,
**the one flagged entry** ([Review](#review)).
Excluded, the interesting half: `.ts/.tsx/.jsx`, `.yml`, `.toml`,
`.sql`, `.sh`, `.py`, `.pem`, `.key`, `.tfstate`, everything extensionless —
which happens to stop a source tree being published, though **it cannot stop a
secret in an admitted type** — and **excluding `.ts` while admitting `.map` would
let the source back in through the file that embeds it**, which the flag answers
and an exclusion list could not. One exception: **extensionless files under a
top-level `/.well-known/`**, from a name→type map.

**Server-side, keys are append-at-will**, but **changing an admitted extension's
*value* is not**. **Client-side the table is frozen in both directions**, because
the CLI admits files by it, so it decides which files a folder *has*.

## Serving

One entrypoint, two reads: `manifests/<root>`, then `blobs/<hash>`. GET and HEAD
serve, `OPTIONS` answers 204 from the method alone with a wildcard CORS
preflight, and anything else is a 405 — all before any read.

**Dispatch on `Host` first**, `:port` and one trailing dot stripped. The table is
total:

```
api.statice.run        →  /v1/* the API; anything else 404, never content
statice.app            →  301 to https://statice.run, path and query kept
ends in .statice.app   →  52 chars = root; contains "-" = slug (L2)
statice.run            →  LANDING_ROOT if set, else 404      [L1 only; see L3]
anything else          →  404, short max-age    [L3: domains/<host> lookup first]
```

Then read the manifest into a `Map`, slicing each line at 64 and 65; a miss is a
404 with no invented fallback. **Resolve the path by splitting on `/` first, then
percent-decoding each segment** (strictly — a malformed sequence is a 404, never
a 500), NFC-normalizing and rejoining. A path ending in `/` tries
`<path>index.html` then `<path>index.htm`; a path that doesn't, and whose
`<path>/` exists, gets a 301 whose `Location` is the **raw** request path plus
`/` and which takes the answering host's cache policy. **No `404.html`, no SPA
fallback, no extensionless lookup** — a lookup table, not a router.

A matching `If-None-Match` returns 304 with no blob read, parsed as the list it
is — **conditionals outrank ranges**, a 304 never carrying a slice. Otherwise
read the blob — one valid `Range` reads only its slice ([Range](#range)) — where
**a miss is reachable only by an operator's deliberate deletion → 404, not a
500**. Then stream into a fresh Response, building every header rather than
calling `writeHttpMetadata`:

```
Content-Type                   from the type table, never from R2
Content-Length                 obj.size — the slice's length on a 206 — via
                               FixedLengthStream (see Gotchas)
Accept-Ranges                  bytes
Cache-Control                  the answering host's policy (below)
ETag                           "<blob hash>"
X-Content-Type-Options         nosniff
Access-Control-Allow-Origin    *
Access-Control-Expose-Headers  ETag, Content-Range
Cross-Origin-Resource-Policy   cross-origin
X-Served-By                    statice
```

**`Cache-Control` is the one header that is a function of the host, not the
bytes**, which keeps the rule stable as hosts are added:

```
<root>.statice.app    public, max-age=31536000, immutable   the root is in the name
statice.run           no-cache                              LANDING_ROOT can move
<slug>.statice.app    no-cache                              layer 2
a bound domain        no-cache                              layer 3
```

Everything else in that block is unconditional on **every** response this path
produces, 404s and redirects included; error bodies get `text/plain;
charset=utf-8`. `ACAO: *` is **the serving path's header** — every byte it emits
is public by definition, and it shares reads, never credentials. **`X-Served-By`
goes on wider than the block**: the entrypoint sets it on every response the
Worker makes, `/v1` answers included, and it is there because `Server` is not
ours to set — Cloudflare's edge overwrites that one with `cloudflare` whatever
the Worker puts in it. **When R2
throws**, one catch at the entrypoint answers **502 with a short `max-age`**, and
never `immutable`.

### Range

**GET honors one range; every other shape of the header gets the full 200** —
the fallback the RFC sanctions, and the one answer that cannot be wrong bytes.
The parse is ours, never delegated to R2 — the percent-decoding ownership rule
again: exactly `bytes=<start>-<end?>` or `bytes=-<suffix>`, one range, no list.
Satisfiable → clamp the end, `get()` that slice alone, answer **206** with
`Content-Range: bytes <start>-<end>/<size>`. Parseable but fitting nothing — a
start at or past the blob's size, a zero suffix, the zero-is-falsy family again
— is **416** carrying `Content-Range: bytes */<size>`, on the error policy like
any other 4xx. HEAD keeps answering 200 whole, and the wildcard preflight
already admits the header, `Range` not being CORS-safelisted.

**`If-Range` is load-bearing, not a nicety.** A slug or domain host serves
different bytes at the same path across deploys, and a client resuming
yesterday's download must not get today's spliced onto it: present and equal to
the strong ETag, the range is honored; present and anything else — the date
form always, nothing here emitting `Last-Modified` — the full 200. **Safari is
why the section exists**: it probes `<video>` with `Range: bytes=0-1` and will
not play without a 206, so the media set was a dead letter while ranges were
ignored.

### Cross-origin isolation

`SharedArrayBuffer` — and every threaded WebAssembly build, `ffmpeg.wasm` through
Godot and Unity exports — needs the document cross-origin isolated, which no page
can arrange for itself.

- **`Cross-Origin-Resource-Policy: cross-origin` on every response, always**, or a
  statice-hosted asset can't be loaded by *any* isolated page anywhere.
- **The signal is a marker file**: a site serves isolated when its manifest holds
  `/.well-known/cross-origin-isolated`, empty. Then **`COEP: require-corp` on
  every response**, and `COOP: same-origin` on `text/html` only.
- **A marker and not an inference**, since most `.wasm` needs no threads and
  isolation breaks every cross-origin popup and iframe; **and not
  configuration**, since being a file it is in the manifest, so **isolation is
  part of the root** and adding it mints a new URL.

### `immutable`, and a new origin every deploy

`https://<root>/app.js` cannot change without a SHA-256 collision, so the
year-long TTL is a statement of fact rather than an optimization with a caveat,
and a repeat visit costs zero invocations and zero R2 reads. **Errors are the
exception** — 60s `max-age`, never `immutable`.

The root is in the hostname, so **every deploy is a different origin**: a new
security principal, not a new path, with `localStorage`, IndexedDB, cookies and
service workers all empty at the new URL. That is what a hash URL is *for*, and
also the ceiling on what one can be — anything that remembers a visitor between
deploys needs layer 2.

**Two R2 reads per request, serial**, both Class B, the manifest re-read once per
asset, and R2's free tier is spent at five million asset requests a month.
**Linear in traffic.** Two levers on latency, neither a cache: the **bucket
location hint** (irreversible, and with nothing in front of R2 it *is* your
latency) and **Smart Placement**.

## CLI

```
$ statice
  scanning 4 files
  uploading 2 new blobs
    /index.html
    /style.css
  → https://q4mfcytc4jz3gr7hnrpvzlqjxdfy2b6k5wmxnh3ttaeqzvjm4h5a.statice.app
```

**Refuse the wrong folder before anything is hashed** — `$HOME` and any
filesystem root are a hard refusal — and **confirm a first deploy from this
folder** ([Review](#review)), where **only the prompt is interactive, never the
listing**, so CI keeps working and its log still carries the record. *First* is
client-side memory: append
`<iso-8601> <root-hex> <absolute path>\n` to `~/.statice/deployed`, **sliced at
byte offsets** because a path may contain spaces. It is **a log, never a source
of truth**, and the only way back to a 52-character URL nobody can retype. **It
is also where `base` comes from** — the most recent line whose path matches cwd —
a use a log can serve precisely because the hint is advisory: stale, truncated or
missing, it costs one wasted read and a full sweep, never a wrong answer.

Then walk cwd, **every rule frozen because each is an input to the root**: prune
`.git`, `node_modules` and dotdirs except a **top-level** `.well-known`; **skip
symlinks**; **drop `CLAUDE.md` and `AGENTS.md`** — case-folded, at every depth,
because `.md` is admitted and agent instructions are written for an agent
standing in the folder, never for the web; admit by the type table; **build the
canonical path here, because the
server will not** — separators to `/`, leading `/`, **NFC**; and record each
file's size while walking. **Record every drop as it happens**, with the rule
that made it, because the review can only account for the folder the walk told
it about. **Name each new blob as it uploads**, so a redeploy lists only the
change ([Review](#review)).
`statice --isolated` writes the empty marker file into the folder and deploys.
**`statice --verify`** skips both shortcuts — the manifest-exists answer and the
`base` subtraction — and sweeps every hash, re-uploading anything an operator has
deleted since: the way back when a site looks broken, and the only one, since a
plain redeploy no longer checks.

### Review

**There is no unpublish.** Manifests are never deleted, hash URLs are permanent
and `immutable`, and keys are validated and discarded — so nothing can prove you
deployed a thing, and **a self-serve retraction is not missing but structurally
impossible without the account this design refuses.** The remedy is an operator
deleting a blob by hand. That is why the pre-publish moment
carries this much weight: it is the only moment there is.

**One rule: a deploy names what is new.** A redeploy's new set is small, so it
lists it outright. A first deploy's new set is the whole folder, and a listing of
847 files is not a review — so that case gets the shape instead, plus the files a
summary must never summarize away.

```
$ statice
  scanning 847 files, 12.4 MB — first deploy from this folder

    /            3 files      2 KB
    /assets    831 files   11.9 MB
    /docs       13 files    480 KB

  flagged — sourcemaps embed original source:
    /assets/app.js.map       1.2 MB
    /assets/vendor.js.map    847 KB

  3 files not an admitted type
    /.DS_Store
    /.gitignore
    /Makefile

  2 paths skipped for other reasons
    /.git/          pruned
    /node_modules/  pruned

  deploy 847 files to a permanent URL? [y/N]
```

- **Top-level breakdown**, counts and bytes, which catches the mistake that
  actually happens: deploying the repo root instead of `dist/`.
- **Every flagged file named**, however many, on **every** deploy in which it is
  new — so a first deploy is not a special case but the case where everything is.
- **The whole folder accounted for**, in two lists because the reasons differ:
  what the **type table** refused, named or — past 20 — tallied by extension,
  and what the **walk** dropped before the table ever saw it: prunes,
  dotfolders, symlinks, agent instructions, a file that would not `stat`. Each
  of those carries the rule that dropped it, and past 20 they tally by *reason*
  rather than by extension, because that is how they cluster. **A pruned tree is
  named with a trailing slash and no count** — it is never walked, and the count
  would cost exactly the work the prune exists to avoid.
- **The total, and the word *permanent*.**

**Flagged is a column on the type table, not a scanner**: it admits the
extension, names the file, reads no bytes, and carries the one line saying why.
Dropping `.map` from the table instead would break the production error reporting
sourcemaps exist for, so **the table decides what a folder has and the
confirmation decides whether you meant it** — the honest split, the table never
having been a security control.

**This is the last moment the flag set is free**, being client-side and so frozen
with the rest of the table once the first real link is shared.

---

# Layer 2 — short names

Layer 1's URL can't be said out loud, and not everyone owns a domain.

```
cool-3d-generator-hfj.statice.app     slugs/<label> → <root: 64 hex> <auth: 64 hex>\n
└──────┬────────┘ └┬┘
    you choose  assigned
```

**The suffix is unconditional, so nobody is ever told a name is taken** — no
landrush, no dispute process, no bare `cool-3d-generator` to contend for. The
record is 130 bytes, fixed width, sliced at offsets, and `auth` is
`SHA256(token)`, so **R2 holds a hash, never a secret.** A `root` of 64 zeros is
a **tombstone**: the label 404s, and because the record survives nobody else can
claim it, while `auth` survives with it so the holder can revive the name.

```
POST   /v1/slugs           { slug, root, auth }             → 201 { label, url }
POST   /v1/slugs/<label>   { root },  X-Statice-Token: <hex> → 204
DELETE /v1/slugs/<label>   X-Statice-Token: <hex>            → 204
HEAD   /v1/slugs/<label>   X-Statice-Token: <hex>            → 204 | 401
```

**Two credentials, never the same thing.** The access key is *admission*, one per
caller on every `/v1` call; the token is *possession*, one per label, generated
locally. **The key gets you in, the token proves the name is yours.** **Never
merge them**: a key that also owned slugs would be an account, with every site
linkable to every other and one leak losing all of them.

**First claim.** The CLI generates 32 random bytes locally and sends only
`SHA256(token)`. The server sanitizes the slug, `head()`s `manifests/<root>` and
rejects if absent, then for each width in `[3,4,5,6,7]` writes
`slugs/<slug>-<suffix>` **conditionally on the key not existing**, spelled
**`onlyIf: new Headers({ "If-None-Match": "*" })`**; exhausted → 503. **Update**
compares `SHA256(token)` to `auth` and writes back with `onlyIf: { etagMatches }`,
so an update racing an operator takedown loses rather than resurrecting the
record. **`auth` is the field that must not skip validation**, the claim being
the only place it is ever examined.

**There is no rotation, so a leaked token is a lost name.** The remedy is the
operator tombstone, then a fresh claim — and the tombstone is a shallow lever
on its own: it keeps the record's `auth`, so whoever holds the token can update
over it again the next time they call, with any admitted key. Against a leaked
token it holds only beside revoking the key that carried the update; against
its rightful holder it is exactly what `retire` relies on. **Delete** is an update to the null root
and never removes the record, since freeing the label would let a stranger serve
their own content at a URL you had already shared. **Check** answers 204 or 401,
so a mistyped token fails where it was typed rather than a day later.

**The suffix** is three characters from layer 1's base32 alphabet, widening on
collision, **generated by the server and never chosen** since a client that picks
can grind. The ladder is not an optimization: **any fixed width has a population
at which claims start failing, and a ladder does not**, which is what lets the
floor be short — 3 characters is 32,768, first-try for nearly every slug. **The
slug** is lowercased, spaces to `-`, anything outside `[a-z0-9-]` dropped, runs
collapsed, capped at 55 — `63 − 7 − 1`, the label limit minus the ladder's
*widest* rung minus the separator — and trimmed of leading/trailing `-` **last**.
**It needs no canonical form**, the suffix being what makes the label unique.
**Host dispatch stays total because the suffix guarantees a `-`, which is not in
base32: contains `-` → slug, 52 characters → root, else 404 — an ordered test.**

## CLI

```
statice                              hash URL only — layer 1, untouched
statice --name "cool 3d generator"   deploy, then claim or update
statice                              .statice present → deploy, then update
statice claim <label>                adopt a name on a second machine
statice names                        every label with a token, and its folder
statice retire [label]               tombstone a label; defaults to .statice's
```

```
.statice                     the label. public, commit it if you like.
~/.statice/key               the access key. one per machine.
~/.statice/slugs/<label>     <token: 64 hex>\n
                             <absolute path of the claiming directory>\n
```

Everything under `~/.statice` is `0600` inside a `0700` directory, and **the slug
update is unconditional** because layer 1's deploy has no answer meaning *stop*.
`--name` defaults to `basename(cwd)` unless that lands in
`{dist, build, out, public, www, site, _site, docs, .output}`, in which case walk
up to the parent, and failing that print the hash URL alone.

The token file's second line is the claiming directory, and the CLI warns when a
deploy runs elsewhere — `cp -r` a project and the copy silently redeploys **over
the original's live site**. It doubles as the only label→folder map there is, and
**losing the token loses the name permanently**, though a label with no matching
token is not an error: deploy to the hash URL and say why.

**A token never appears in argv or on stdout**, and **it reaches disk before the
network is trusted** — written to `~/.statice/slugs/.pending-<16 random hex>`
*before* the POST, promoted on success, and never silently deleted, so a re-claim
**sends that file's `auth` and promotes that same file** rather than minting
fresh bytes. **Exit codes split on what was asked for**: `--name` on an unnamed
folder wants a *name*, so a 503 exits non-zero, while bare `statice` wants a
*deploy*, so the same 503 exits zero. **`STATICE_TOKEN` and `STATICE_KEY`**
override the files for machines with no durable home directory. **`retire` takes
a label**, clearing `.statice` but **keeping the token file**, since not clearing
it would quietly revive the name just retired while deleting the token would make
the tombstone permanent. **`--name` beside an existing `.statice` compares slugs,
not strings**: a match is an update, and **anything else is a rename, which is a
new claim** — a second label, token and site, while the old one keeps serving
frozen at its last root, so **confirm first**.

## Serving

A slug host **proxies**; redirecting to the hash host would move the origin on
every deploy, and a stable name whose origin moves is not a stable name. **No
server-side cache of the slug record**, so a deploy is live the instant the
record is written. `Cache-Control: no-cache` plus `ETag: "<blob hash>"`, uniform
across HTML and assets, so a match is a 304 with no blob read — and **the
trailing-slash 301 takes `no-cache` too**.

**Not `stale-while-revalidate`, not a small `max-age`, and not a one-second
server-side cache of the record** — the last will be proposed, and its window is
in the wrong place: a deployer refreshing as the record is written gets a page
that is *half old and half new*, because assets resolve against whichever record
their own request caught. **Assume nothing is content-hashed.** Cost is one
invocation per asset per pageview and one R2 read or two — ~$13/million pageviews
warm, ~$20 cold, paid only where a name is used.

**The one cache** is `const manifests = new Map()` in module scope, root-hex →
`Map<path, hash>`. The key is content-addressed, so the value can never change:
**evict by LRU on a bound, never by age**, which makes it the only cache in the
system that structurally cannot serve something stale. **The bound is a charge of
4× the manifest's byte length, and the budget is 8 MB** — the multiplier because
what is *retained* is two JS strings per entry, which raw length undercounts
three to five times. **This is a real amendment to layer 1**: two reads per
request becomes one on a warm isolate, and hash hosts get the map too. Every
*other* cache anyone proposes here is a cache of a mutable name.

**What layer 2 adds:** one R2 prefix, four routes on two paths, one branch in the
host parse, one in-memory map. Deleting the slug routes restores layer 1 exactly.

---

# Layer 3 — custom domains

```
app.example.com   →   cool-3d-generator-hfj   →   <root>
└──────┬───────┘      └──────────┬──────────┘
  your domain            your label, layer 2
```

**A domain binds to a label, never to a root**, so the deploy path does not
change and every bound domain follows every deploy. The system keeps one kind of
mutable pointer, and this layer adds a pointer *at* it rather than a second kind.

**Two modes, differing in one step: who provisions the certificate.**
*Own-zone* — the domain's zone is in the same Cloudflare account as the Worker,
so certificates are the zone's own and free; launch mode. *Multi-tenant* —
anyone else's domain, through **Cloudflare for SaaS**; the mode strangers need.
Everything user-visible is identical. `OWNED_ZONES` lists the account's zones,
and *underneath* means with the dot — `host === zone || host.endsWith("." + zone)`.
With no SaaS credentials that path answers "not enabled" and writes nothing, so
launch needs no SaaS setup and strangers later need no redesign.

**The record** is `domains/<host>` → `<label>\n`, host lowercased, with **no auth
field** — a domain is authorized by two credentials the record does not store:
the label's token, and control of the domain's DNS, checked live every time it
matters.

## The proof

```
_statice.<host>   TXT   "<label>"
```

**Deliberately not the CNAME**, which is flattened at every apex and masked by
the proxy on every own-zone host — a proof half the legitimate host shapes cannot
exhibit is not a proof. The record names the label, so the DNS itself states
*this hostname should serve that label*, and neither party alone can bind: an
attacker cannot pre-bind `app.victim.com` (they can't write the TXT), cannot race
a victim who published first (it names the victim's label, whose token they don't
have), and squatting a hostname before its owner arrives has no move.

**The record is a standing assertion, not a one-time challenge.** Nothing
consumes or expires it, so removing it *retracts the sentence* and the binding it
authorized becomes deletable by anyone — which is what makes the departure path
honest: a locked-out owner releases the hostname with a DNS edit followed by one
unbind call that needs no token. That is the whole contract. **Nothing
re-checks the record on a timer**: serving never looks at DNS, and the
dangling-hostname reconcile below compares registrations with `domains/`, never
with TXT — so a binding whose record is gone keeps serving until someone asks
for its removal. The cost is that **the record must be called permanent
everywhere it is printed.**

**Resolution is DoH against a fixed resolver**, answers unquoted and joined, any
one record matching counting. One discipline the whole layer leans on: **only a
successful response proves absence** — NXDOMAIN or an empty answer is absent,
while SERVFAIL or a timeout is *unknown*, and unknown authorizes nothing.

**Routing is separate**: own-zone, the Workers custom domain is the whole job;
multi-tenant, `<host> CNAME connect.statice.app`, left **DNS-only** if the
tenant's zone is itself on Cloudflare.

## Binding

```
POST   /v1/domains          { host, label }, X-Statice-Token: <hex>  → 202
DELETE /v1/domains/<host>   X-Statice-Token: <hex>, or none          → 204
```

**Lowercase the host, then validate it** — the expression is lowercase-only, so
`App.Example.com` fails outright if the fold comes second — against

```
^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$
```

plus **244 bytes or fewer**, which is 253 minus the nine that `_statice.` adds to
the name actually queried. Three rejections sit on top: an IPv4 literal, a
wildcard, and `statice.app` / `statice.run` and anything under either. Then
compare `SHA256(token)` to the label's `auth`; **check the proof over DoH**, where
absent or naming another label returns a structured rejection carrying the exact
record to add; register the custom hostname unless own-zone; and write
`domains/<host>` → 202, naming the mode and what remains manual.

**The proof precedes the only step that spends money**, which keeps per-hostname
billing non-grindable. **It is also the order that can leak, invisibly to a reconcile
that walks `domains/` alone**: registration succeeds and the R2 write fails, so a hostname
bills monthly with no record naming it. So **the dangling-hostname reconcile runs
both ways** — list the zone's custom hostnames, subtract what `domains/` accounts
for, unregister the rest. It is multi-tenant only, and it is billing
reconciliation rather than garbage collection: there is none of the latter.
**Unbind reverses the order**, deleting the record first, so
both fail toward a state the reconcile can see.

**POST is the update too**: same host, different label, that label's token, TXT
updated → the domain moves. That is the whole rename story, since a layer 2
rename leaves bound domains pointing at the old label. **Unbind takes the label's
token — or nothing at all, once the proof is gone**, because the TXT's absence
*is* the domain saying it no longer wants the binding, and re-binding demands DNS
control a departed owner still has. **The honest window is a domain whose TXT
goes missing while its owner still wants it** — an outage, never a takeover.
**Unbinding a host with no record is a 204, not a 404. No tombstone**, since
re-binding `app.example.com` requires controlling `example.com`.

**TLS.** Own-zone is free and already solved. Multi-tenant is a product rather
than code — **Cloudflare for SaaS**, ~$0.10/hostname/month past the free hundred,
with a Worker as fallback origin. **Prove that wiring end to end with one real
hostname before building anything on it**; it is the only part a doc page cannot
confirm. **No status endpoint** — the CLI polls `https://<host>/` and watches the
handshake.

## Serving, and self-hosting

```
api.statice.run        →  /v1/* the API; anything else 404, no lookup
statice.app            →  301 to https://statice.run — never a domains/ lookup
ends in .statice.app   →  layers 1 and 2, unchanged; case not folded
anything else          →  domains/<host>, lowercased; no record → 404
```

**Four rows, and `statice.run` is not one of them** — it is the catch-all,
reached like any other bound domain, **so this layer deletes a row rather than
adding one**: layer 1's `statice.run → LANDING_ROOT` retires into the catch-all,
replaced by one `domains/statice.run` record, and **the var retires when the
record lands** or the dead pointer still answers first. From the record onward it
**is** a slug host, and **isolation follows for a better reason: it lives in the
manifest, not on a hostname.** **Three R2 reads per asset warm, four cold** —
caching the root inside the domain record would collapse one and is wrong twice,
putting the deploy path back into the domain business and manufacturing the drift
the label indirection exists to prevent.

So the landing page and docs are a statice site served by statice, reached
through that catch-all; the API lives on its own host, so **the landing site
gives up no path shapes at all**. The bind API still refuses `statice.run`, so
the operator writes that record directly. **Bootstrap is sequencing, not
circularity**: the Worker deploys first, the landing folder deploys *through* the
API and claims a name, the operator writes the record, and every later edit is
bare `statice` in the folder.

## CLI

**No DNS lookups in the CLI** — the server owns the check — **but it does not
POST until the record exists**, because a lookup before then **seeds the
resolver's negative cache** for the zone's negative TTL. With no TTY the prompt
is skipped and the bounded retry is the whole safety net; **both loops carry a
deadline**, the POST retry as well as the poll. **The word the CLI must not drop
is *leave*** — every beat reads like a one-time challenge, so the prompt says the
record is permanent, the 202 repeats it, and `statice domain rm` prints it
inverted.

```
$ statice domain app.example.com
  add this record at your DNS provider — and leave it there:

      _statice.app.example.com   TXT   "cool-3d-generator-hfj"

  this is not a one-time check. the record is what keeps the binding
  yours; removing it releases app.example.com.

  press enter when it is in place …
  checking the proof ... ok
  own zone — attach app.example.com to the Worker in the dashboard
  waiting for https://app.example.com ... ok
  → https://app.example.com
```

**What layer 3 adds:** one R2 prefix, two routes, one CLI verb, **no new dispatch
row**, one env var gained (`OWNED_ZONES`) and one given up (`LANDING_ROOT`).

---

# Gotchas worth a test

Each of these fails silently or late, and each has a test that holds it.

- **Zero is legal and `0` is falsy.** `Content-Length: 0` is the isolation
  marker; match `^[0-9]+$` before converting, and treat `head()` presence as
  non-null rather than a truthy size.
- **`Content-Length` on a streamed Response is dropped** unless it goes through
  `FixedLengthStream(obj.size)`, whose pipe must not be awaited and must carry a
  `.catch()`. Assert the header on a real response, not by reading the code. The
  CLI has the mirror of this: **send `Uint8Array` bodies, never streams**, or
  every upload 411s from a client that looks correct.
- **A ranged `get()` still reports the whole object in `obj.size`.** It is
  `Content-Range`'s denominator and never the 206's `Content-Length` — the
  slice's own length feeds `FixedLengthStream` there, and swapping them breaks
  only under a resuming client.
- **Honoring `Range` while ignoring `If-Range` splices two deploys into one
  download** on any `no-cache` host. Equal to the strong ETag or answer the
  full 200 — and the date form is never equal, nothing here emitting
  `Last-Modified`.
- **Never buffer a blob body to hash it.** `crypto.subtle.digest` wants all
  64 MB at once in an isolate that has 128 for everything it is doing — the key
  goes in `put()`'s `sha256` option, and R2's refusal must be told apart from
  R2 being down, or a corrupt upload reads as an outage.
- **`onlyIf` returns `null`; it does not throw**, on both the claim ladder and a
  lost update race — and the object form's `etagDoesNotMatch: "*"` has a filed
  bug treating `*` as a literal etag.
- **The `-` test must run before the length test** in host dispatch, or a
  48-character slug at width 3 makes a 52-character label that 404s a live site.
- **Percent-decode per segment, after splitting on `/`**, or `%2F` mints a second
  URL for the same bytes.
- **`domains/` values carry a trailing newline** — take everything before the
  first `\n`, or every bound domain 404s while the record sits correct in R2. A
  **trailing dot** on a bound host is the mirror: it validates and never serves.
- **COEP must go on every response, not just documents**, or threaded WASM in a
  worker is `blocked` while `crossOriginIsolated` still reads `true`.
- **`statice key`'s digest ≠ `echo "$KEY" | shasum -a 256`**, which hashes a
  trailing newline and matches nothing — indistinguishable from a missing secret.
- **`LANDING_ROOT` left set after `domains/statice.run` exists** means the stale
  dispatch row answers first, and the landing page stops following its deploys.
- **The `base` subtraction keys on hash, never on path.** The base manifest is
  `<hash> <path>` and the temptation is a path→hash map: a moved file is then
  re-uploaded for nothing, and — the half that is a bug — **a path whose bytes
  changed is subtracted as unchanged**, writing a manifest over a blob that was
  never uploaded and breaking the one invariant the sweep exists to hold.
  Subtract the hash set and ignore the paths entirely.
- **A first deploy prints its listing with no TTY**, and skips only the prompt.
  Gating the whole block on `isatty` is the natural way to write it, and leaves
  CI publishing unreviewed folders in silence.
- **A drop the listing cannot name is a drop nobody reviews.** Counting only the
  type table's refusals reads as complete and is not: the symlink, the pruned
  tree and the dropped `CLAUDE.md` leave without a word, and the folder you
  reviewed is not the folder you deployed. Every rule that removes a path
  records it.
