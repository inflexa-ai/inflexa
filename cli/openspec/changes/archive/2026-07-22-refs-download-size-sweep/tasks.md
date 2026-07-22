## 1. Trustworthy declared sizes

- [x] 1.1 Reject a `Content-Length` on any response carrying a content encoding other than `identity` in `declaredContentLength`, and correct the comment that asserts the case cannot arise.
- [x] 1.2 Cover it: a response with both headers yields no declared size, so the in-flight readout can never show received exceeding declared.

## 2. The sweep

- [x] 2.1 Have `referenceDownloadEstimate` return the artifacts it plans to fetch alongside the count, so the plan is resolved once.
- [x] 2.2 Add `measureReferenceDownload(artifacts, deps)` returning `{ bytes, sized, unsized }` — a plain value, never a `Result`, because no outcome of a probe is a failure of the caller.
- [x] 2.3 Issue one `HEAD` per artifact through a `p-queue` capped at `DEFAULT_SIZE_PROBE_CONCURRENCY` (20), every request sharing one `AbortSignal` started for the sweep and bounded by `SIZE_PROBE_BUDGET_MS`.
- [x] 2.4 Collapse every error, timeout, non-ok status, and untrustworthy header to "unsized"; write nothing and touch no install state.

## 3. Consent and readout

- [x] 3.1 Render the plan with bytes when known — exact when every artifact is sized, an explicit lower bound plus the unsized count when partial, the file count alone when nothing is.
- [x] 3.2 Run the sweep after the headless no-consent return, under a spinner on a real terminal, so a scripted refusal makes no request and keeps its wording.
- [x] 3.3 Give the readout the measured total: `1.4 GB/8.2 GB`, suffixed `+` while any planned artifact is unsized.
- [x] 3.4 Reduce the in-flight segment to a bare count when a plan total exists, so only one byte pair appears on the line.

## 4. Seams

- [x] 4.1 Add a `fetch` seam to `ReferenceDownloadOptions`, threaded to both the sweep and the installer, and supply it from every command test so none reaches an upstream.

## 5. Tests

- [x] 5.1 `measureReferenceDownload`: all sized, partially sized, none sized, a rejecting/erroring probe, a content-encoded response, and a non-ok status — each yielding unsized rather than an error.
- [x] 5.2 Concurrency is bounded at the configured limit and every request carries the shared signal.
- [x] 5.3 Plan wording across the three knowledge states, and the headless refusal issuing no request.
- [x] 5.4 Readout: denominator present, `+` suffix while unsized, in-flight reduced to a count when a total exists, and the existing fraction retained when there is none.

## 6. Verification

- [x] 6.1 `bun run lint`, `bun run typecheck`, `bun test` in `cli/`.
- [x] 6.2 Drive a real plan under a pty against a throwaway `XDG_DATA_HOME`: confirm the measured total at consent, then decline.
- [x] 6.3 `bun run format:file` on every changed file under `src/`.
