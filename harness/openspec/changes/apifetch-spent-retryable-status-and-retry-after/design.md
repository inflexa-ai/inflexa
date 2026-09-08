# Design

## Context

`runFetch` (`src/tools/lib/api-utils.ts:89-129`) loops over the attempts.
The retry branch at line 103 has the guard `attempt < maxRetries`, thus on
the last attempt a retryable status falls to the generic non-ok arm at line
109. There it becomes `http_status`, the same as a 404. `isUnexpectedApiError`
(lines 155-157) reads each `http_status` in the 4xx band as expected. The
`exhausted` variant at line 128 is reachable only after the `catch` arm falls
out of the loop.

The sleep at line 104 is `retryDelayMs * 2 ** attempt`. It never reads
`Retry-After`. `src/literature/sources/http.ts:45-52` parses the header, and
line 74 applies `Math.min(maxRetryDelayMs, retryAfter ?? backoff)`.
`src/providers/ai-sdk.ts:291-319` reads `retry-after-ms` and `retry-after`,
and it treats a value outside `[0, RETRY_MAX_DELAY_MS]` as absent.
`RETRY_MAX_DELAY_MS` is 30 000 ms.

`sleep` (`src/lib/async-utils.ts:8-10`) is a bare `setTimeout`. It takes no
`AbortSignal`, and these calls run inside DBOS steps.

`describeApiError` (lines 132-143) is the only reader of `attempts`,
`lastError`, and `body`. No code matches the `exhausted` variant by name. The
31 explicit `http_status` matchers in the clients test 404, 204, or 400 only.

## Goals / Non-Goals

**Goals:**

- A retryable status that outlives the retries is an unexpected error at each
  call site, with no client change.
- The retry wait obeys `Retry-After`, under a finite cap.
- A test observes the wait without real time.

**Non-Goals:**

- The 20 call sites that return `[]` or `null` on each `ApiError` with no
  classification. That is a different concern, and it swallows a 5xx too.
- A new `ApiError` variant. Nothing reads the status of a spent retry today.
- A cancelable sleep. The finite cap is the guard.
- The `retry-after-ms` header. It is a gateway convention of the model
  providers, and no bio provider sends it. The literature layer reads
  `Retry-After` only, and this layer does the same.
- A stubbed-fetch unit test for Monarch. It is out of scope for this issue.

## Decisions

### D1. A spent retryable status reuses the `exhausted` variant

When `RETRYABLE_STATUSES` holds the status and no retry remains, `runFetch`
returns `err({ type: "exhausted", attempts: attempt + 1, lastError })`, and
`lastError` is `HTTP <status>` from that response. `isUnexpectedApiError`
already returns true for `exhausted`, and the `switch` of `describeApiError`
stays exhaustive. Thus the eleven call sites change behavior with no edit.

`lastError` comes from the final response, not from the loop variable. A run
whose earlier attempts failed with a connection error would otherwise report
`fetch failed` for a 429. `attempts` is `attempt + 1`, thus a `maxRetries: 0`
caller reports 1, consistent with the `catch` path.

Alternative: a new variant `retries_exhausted` with the status and the body.
Rejected. It touches `describeApiError` and adds a shape for a question that
no caller asks. The body of a spent retryable status is dropped. Nothing reads
it for a 429 today.

### D2. The header parse is a private copy of the literature parser

`retryAfterMilliseconds(res)` reads `Retry-After` as seconds first, then as an
HTTP date relative to now, clamped at zero. A date in the past gives a wait
of zero. A value that is not a number and not a date, or a negative number,
counts as absent, and the backoff governs. It is the twelve lines of
`http.ts:45-52`, copied. An import from the literature layer is rejected.
That module has its own schedule, signal, and result type. A dependency
between the two layers is worse than twelve lines.

### D3. One finite cap on every wait

`ApiFetchOptions` gains `maxRetryDelayMs`, the ceiling on any single wait, the
server value included. The default is 30 000 ms, the same as
`RETRY_MAX_DELAY_MS` of the provider envelope. The cap applies to the status
path and to the transport-error path: `Math.min(cap, retryAfter ?? backoff)`
on the status path, and `Math.min(cap, backoff)` on the `catch` path.

The default is finite on purpose. `http.ts:59` defaults to infinity, but that
layer has a cancelable sleep. This layer has none, and an uncapped
`Retry-After: 3600` would park a DBOS step for an hour.

Alternative: treat a server value above the cap as absent, the way `ai-sdk.ts`
does. Rejected. A server that asks for a long wait still asks for a wait, and
the capped wait is closer to its ask than the backoff.

### D4. A `sleep` option for the test

`ApiFetchOptions` gains `sleep?: (ms: number) => Promise<void>`, with the
shared `sleep` as the default. The test passes a function that records the
wait and returns at once. This mirrors `SourceHttpOptions.sleep` in
`http.ts:16`, and `http.test.ts:40-58` is the template.

Alternative: assert on the elapsed time. Rejected, because a timing assertion
is flaky, and a real wait of 50 ms in a unit test is waste.

### D5. The doc comments state the exception

The header comment of `apiFetch` (lines 39-44) changes, and the comment of
`isUnexpectedApiError` (lines 145-154) changes. Each one says that a 4xx is
expected, unless it is a retryable status that outlived the retries. That status arrives as
`exhausted`, and the caller must treat it as unexpected.

### D6. The specs change in place, and the sync corrects one purpose text

The ChEMBL requirement is the one statement of the `apiFetch` policy, and it
gets the new clauses. The `harness-tools` requirement and the AlphaFold
requirement each gain a throttle scenario. The purpose text of
`alphafold-tools` says that `isUnexpectedApiError` classifies each 4xx as
expected. A purpose text is not a requirement, thus no delta carries it. The
agent-driven sync replaces that sentence with this one: "`isUnexpectedApiError`
classifies each `http_status` in the 4xx range as expected, thus both become
`ok({ found: false, uniprotAccession })` and not a thrown error. A 429 that
outlives the retries is the exception. It arrives as `exhausted`, and the
tool throws."

## Risks / Trade-offs

- [A throttled dossier run fails loudly] → `workflows/target-assessment/collectors/index.ts:83-88`
  maps a throw to `coverage: "queried_no_data"`. Under load, bgee, impc, and
  monarch report `queried_no_data` where they reported a thin bundle. That is
  the correction, and a coverage dashboard can show it as a regression.
- [Hundreds of log lines from a throttled ChEMBL] → `chembl-client.ts:607` and
  `762` fan out at concurrency 5, and each dropped molecule writes one error
  record. Accepted. A silent drop is the fault that the schema-fidelity spec
  forbids.
- [A `maxRetries: 0` caller gets `exhausted` for a 503, not `http_status`] →
  The classification is the same. Only the message changes, and no test
  asserts the old shape.
- [The body of a spent retryable status is dropped] → Nothing reads it for a
  429 today. A future reader adds a variant then.
- [An uncapped wait blocks a DBOS step] → D3. The cap has a finite default.
