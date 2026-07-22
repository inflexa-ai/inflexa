## Context

`referenceDownloadEstimate` (`store.ts`) walks the plan against local receipts and returns one number: how many artifacts are not already intact. That is the only thing the consent prompt can say, because `ReferenceDataCatalog` carries no sizes — a deliberate choice, since a size baked into the catalog would go stale against an `unpinned` upstream. The progress readout inherits the same limit: its bar is denominated in files, and its byte segment is a running total with nothing to divide by.

Measurements against the live catalog, all reproduced before this design was written:

| | |
|-|-|
| Artifacts answering `HEAD` with `200` | 122 / 122 |
| Declaring `Content-Length` | 108 |
| …of which describe the bytes that reach disk | 103 (21.90 GB) |
| …of which are `Content-Encoding: gzip` | 5 |
| Declaring no length (all `Content-Encoding: gzip`) | 14 |
| Sweep wall-clock, concurrency 20 | 1.6 s |
| Declared vs. downloaded, 8 hosts incl. both redirecting ones | 8 / 8 exact |

## Goals / Non-Goals

**Goals:**

- Someone approving a reference install knows roughly how many bytes it moves.
- The transfer readout shows progress toward a total rather than a number that only climbs.
- Partial knowledge is stated as partial, never rounded up into a confident total.
- A size probe can never fail, slow, or alter a download.

**Non-Goals:**

- Sizes in the catalog. A pinned size is a second thing to keep true about a mutable upstream, and the publisher already answers authoritatively at plan time.
- An ETA. Rate is measured over a trailing window and the tail of a plan is not the head; a remaining-time figure would be the most confidently wrong thing on the screen.
- A byte-denominated progress bar. The file count is the one denominator that is always fully known, and a bar that switches units depending on what the upstreams happened to declare is worse than a stable one. The bytes go in the text beside it.
- Resumable downloads. The `If-Range` `TODO(robustness)` stays open.

## Decisions

### A declared length is unusable when the response is content-encoded

`data.broadinstitute.org` answers `Content-Length: 20551` together with `Content-Encoding: gzip` for a file that lands at 48690 bytes, because `fetch` inflates the body before it reaches the stream we count. The header is not wrong — it describes the encoded entity — but it does not describe what this code measures, so treating it as a size makes the readout show more received than declared.

`declaredContentLength` therefore returns `undefined` for any coding other than `identity`. Its existing comment claimed the case could not arise; it can, on five catalog artifacts today. Rejecting rather than converting is the only honest option, since the inflated size is not derivable from the compressed one.

Requesting `Accept-Encoding: identity` was considered and rejected: it would make the header trustworthy by changing what is transferred — more bytes over the wire for every text artifact — and servers are free to ignore it, so the guard would still be needed.

### The sweep is bounded at 20, not unbounded

Measured: unbounded 0.8–1.4 s, 20 → 1.6–1.7 s, 8 → 3.0 s. Unbounded buys a few hundred milliseconds at 122 artifacts and gets worse from there. The catalog already clusters per host — 12 artifacts on zenodo, 11 on `data.broadinstitute.org`, 8 on github — so an unbounded sweep opens a dozen simultaneous connections to a single publisher where a browser would open six, and a catalog several times this size would arrive as a burst that invites rate-limiting from the very hosts the download then depends on. A bound also makes the shared deadline meaningful: unbounded, every request starts at once and the budget degenerates into a per-request timeout.

`p-queue` is already the installer's limiter, so this reuses the idiom rather than introducing a second one.

### The sweep cannot fail

`measureReferenceDownload` returns a plain value, not a `Result`. This is not a shortcut around the `neverthrow` rule — the function genuinely has no failure mode. A transport error, a timeout, a `405`, a redirect off https, a malformed header, and a content-encoded response all mean the same thing to the caller: that artifact's size is unknown, which is a state the readout already had to handle. Turning any of them into an error would let a metadata probe fail a download that would otherwise have succeeded.

The https check the download path enforces is deliberately *not* mirrored here. A probe that redirects off https tells us nothing we should act on; the transfer refuses it properly, at the point where bytes would move.

### One shared deadline, not a per-request timeout

Every probe receives the same `AbortSignal`, started once for the sweep. A per-request timeout bounds each attempt but not the sweep — with a queue, 1000 artifacts behind a 10 s timeout could stall a wizard for minutes. One signal caps the whole step regardless of catalog size; whatever has not answered when it fires is unsized, which is a state already handled.

### Partial knowledge is marked, in both places it is shown

Bytes are reported alongside the count of artifacts that declared nothing. While that count is non-zero the number is a floor: consent says `at least 8.2 GB … (4 files whose upstream did not state a size)` and the readout suffixes its denominator `8.2 GB+`. When every planned artifact is sized the qualifiers disappear rather than being rendered as decoration.

With a plan total present, the in-flight segment drops to a bare count. Its byte fraction existed because the plan had no total to show; keeping both would put two byte pairs on one line, the smaller of which describes a subset — the exact ambiguity the fraction was introduced to avoid.

### The sweep runs after the headless consent gate

A non-interactive run without `--yes` returns before any transfer, so sizing it would spend network on a plan that cannot proceed and would change an error message that scripts match on. The sweep is placed after that return: the headless refusal keeps its file-count wording and makes no request, while every path that either asks for consent or draws a readout gets measured bytes.

## Risks / Trade-offs

- **A publisher that answers `HEAD` differently from `GET`.** → Verified equal across eight hosts including both that redirect; and the consequence is bounded, since the count of files — not the byte figure — remains the progress denominator and the final summary reports observed bytes.
- **The sweep adds a wait before the consent prompt.** → 1.6 s for the entire catalog, under a spinner, and capped by a shared budget. A typical plan is a fraction of that.
- **A publisher could rate-limit the sweep and then the download.** → The bound at 20 exists for this; it is well under what the transfer itself opens per host.
- **`bytesToFetch` is a floor whenever any artifact is unsized**, and a reader could take it as a total. → Never rendered bare: the `at least` phrasing and the `+` suffix carry the qualification into both surfaces, and the unsized count is stated outright at consent.
