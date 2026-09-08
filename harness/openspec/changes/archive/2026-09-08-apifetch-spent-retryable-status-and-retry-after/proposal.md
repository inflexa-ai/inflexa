# apiFetch: a spent retryable status is an unexpected error, and the wait obeys Retry-After

## Why

Issue #522 reports two faults in `apiFetch`, the shared HTTP boundary of the
bio tools. A 429 that survives the last retry returns as `http_status`, and
`isUnexpectedApiError` reads each 4xx as an expected absence. Thus a throttled
request becomes `found: false`, `null`, or an empty list at eleven call sites,
and the tool description tells the agent not to retry. And the retry wait
ignores the `Retry-After` header, while the two other HTTP layers of the
package obey it. The review of PR #518 found this.

## What Changes

- A retryable status on the last attempt returns the `exhausted` variant, with
  the status in `lastError`. `isUnexpectedApiError` already reads `exhausted`
  as unexpected. Thus each call site that classifies with it throws or logs,
  and no client changes.
- The retry wait reads `Retry-After`, in seconds or as an HTTP date. A new
  option `maxRetryDelayMs` caps each wait, the server value included. The
  default cap is 30 seconds, the same as the provider retry envelope.
- A new option `sleep` lets a test observe the wait. It mirrors the `sleep`
  option of the literature HTTP layer.
- The doc comments of `apiFetch` and `isUnexpectedApiError` state the new
  rule: a 4xx is expected, unless it is a retryable status that outlived the
  retries.
- Five tests in `api-utils.test.ts` pin the new behavior. The cases are the
  spent 429, the recovered 429, the capped `Retry-After` wait, a date in the
  past, and a negative count.

## Capabilities

### New Capabilities

None. No capability owns `apiFetch` today, and the retry policy lives in the
ChEMBL spec. A new one-requirement capability is sprawl, thus the policy stays
where it is and gets the new clauses.

### Modified Capabilities

- `chembl-tools`: the requirement "Error handling, retry, and timeout" gains
  the `Retry-After` clause, the cap, and the rule for a spent retryable status.
- `harness-tools`: the requirement "Tools distinguish expected outcomes from
  unexpected failures" gains a scenario for a throttle that outlives the
  retries.
- `alphafold-tools`: the requirement "AlphaFold DB structure prediction tool"
  gains a scenario for a throttle that outlives the retries. At the sync, the
  purpose text that says each 4xx is expected gets the same exception.

## Impact

- `harness/src/tools/lib/api-utils.ts`: `ApiFetchOptions`, `runFetch`, and
  two doc comments. This is the one production file.
- `harness/src/tools/lib/api-utils.test.ts`: five tests.
- Eleven `isUnexpectedApiError` call sites change behavior with no code change:
  `alphafold-client.ts`, `bgee-client.ts`, `impc-client.ts`,
  `monarch-client.ts`, `chembl-client.ts`, and `iuphar-client.ts`. A spent 429
  throws there, or it writes a log record where it was silent.
- The `bio-api-schema-fidelity` rule "A silent degradation site reports the
  unexpected cause" becomes true for a throttle at `chembl-client.ts:30` and
  `iuphar-client.ts:276`. No delta is necessary.
- `api-utils` is not in `harness/src/index.ts`. No embedder sees the change.
- No new dependency.
