## Why

The consent prompt quotes a file count and nothing else, because the catalog pins no sizes. The transfer that follows then prints a byte counter that only climbs — `12/38 files · 1.4 GB` — which reads as a total that keeps growing rather than as progress toward one. Someone approving a reference install today cannot tell whether they are about to move 200 MB or 22 GB, and nothing during the transfer tells them either.

The catalog cannot answer that, but the publishers can. A `HEAD` sweep over the planned artifacts was measured against the live catalog: all 122 answer `200`, 103 declare a size we can trust, and the whole sweep completes in **1.6 s** at a concurrency of 20. Every declared size was checked against a real download across eight distinct hosts — including both that redirect — and matched to the byte.

The sweep also exposed a defect in shipped code. `data.broadinstitute.org` answers with `Content-Length: 20551` *and* `Content-Encoding: gzip`, while `fetch` inflates the body transparently, so 48690 bytes reach disk — 2.4× the declared figure. `declaredContentLength` accepts that header today, and its own comment asserts the case cannot arise ("`Content-Length` is absent on … on-the-fly-compressed responses"), so the in-flight readout can already show more bytes received than declared. Five catalog artifacts are in exactly that state.

## What Changes

- **`declaredContentLength` rejects a response that carries a `Content-Encoding`.** The header then counts compressed bytes the runtime will inflate before they reach disk, so it describes something other than what is being measured. This corrects the in-flight readout as well as the new sweep.
- **`referenceDownloadEstimate` reports the artifacts it plans to fetch**, not only how many, so the plan can be measured without resolving it twice.
- **New `measureReferenceDownload`**: a bounded, parallel `HEAD` sweep over those artifacts returning the bytes declared, how many artifacts declared one, and how many did not. It runs through a `p-queue` capped at 20 and under one shared wall-clock budget. It **cannot fail** — every transport error, timeout, refusal, and untrustworthy header collapses to "unsized", because a metadata probe must never turn into a failed download.
- **Consent states bytes when they are known.** `38 files, 8.2 GB to fetch`; `at least 8.2 GB` with the count of unsized artifacts when the knowledge is partial; the existing file-count-only wording when nothing could be sized.
- **The transfer readout gains a denominator** — `1.4 GB/8.2 GB` — suffixed `+` while any planned artifact is unsized, so a floor is never painted as a total. With a plan total present the in-flight segment drops back to a count, since its byte fraction existed only to substitute for the total that now exists.
- The sweep runs only where it can inform something: after the headless no-consent path has already returned, so a scripted run that will refuse for lack of `--yes` still makes no network request and its message is unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-data-provisioning`: the pre-transfer estimate gains a measured byte total with an explicit unsized count; consent and the progress readout state it; the declared-size rule excludes content-encoded responses.

## Impact

- `cli/src/modules/refs/store.ts` — `declaredContentLength`, `ReferenceDownloadEstimate`, and the new `measureReferenceDownload` plus its concurrency and budget constants.
- `cli/src/modules/refs/commands.ts` — the plan/consent wording, the spinner around the sweep, and the readout's denominator.
- `ReferenceDownloadOptions` gains a `fetch` seam so the sweep is injectable; the command tests supply one, since they must never reach an upstream.
- No new dependency: `p-queue` is already used by the installer.
