## 1. Compose a diagnosable provider message

- [x] 1.1 In `src/providers/errors.ts`, add a response-body reader that walks the `cause` chain (reusing `MAX_CAUSE_HOPS`, alongside `extractStatus`) for a captured provider response body — the AI SDK exposes it as `responseBody` on `APICallError`.
- [x] 1.2 Add `PROVIDER_BODY_EXCERPT_MAX_LEN = 120` and a single-lining excerpt helper. Comment the derivation at the constant: the tightest downstream consumer truncates the whole line at 200, and workload + `HTTP <status>` + reason phrase runs to roughly 80, so 120 is the largest round value that cannot evict the lead. Deliberately not shared with `PROFILE_ERROR_MAX_LEN` — that bounds a ledger column, this bounds a message many non-ledger consumers read.
- [x] 1.3 Rewrite the `provider` arm of `toProviderError` (`:93`) to compose `workload` + status (when `extractStatus` found one) + detail + the body excerpt, matching the shape the `auth`/`budget`/`tenant-blocked` arms already use. Compose strictly after `classifyProviderError` returns so classification cannot key on message text.
- [x] 1.4 Handle the empty-detail case: when the SDK message is empty (no HTTP reason phrase, e.g. an HTTP/2 hop), the composed message must still identify workload and status rather than trailing an empty segment.

## 2. Stop the failed state implying a verdict

- [x] 2.1 Remove `inputSetSinceFailure` and its `InputSetSinceFailure` type from `src/tools/research/inspect-data-profile.ts`. It is underivable here: `FailedOutput` is reached only under `if (!result)`, and the tool's single ledger row carries no record of the analysis's current input set — that is embedder knowledge. Every branch but `"unknown"` was unreachable.
- [x] 2.2 Add `failedAt: string | null` to `FailedOutput` from the row's recorded completion time, and word the `message` so it states the failure describes an earlier attempt whose relationship to the current inputs this row cannot establish. Do not assert or deny staleness.
- [x] 2.3 Leave `AbsentOutput` unchanged, keeping the existing comment. Its "a constant field carries no information" reasoning is the same reason 2.1 removes the field from `FailedOutput`; make that connection explicit so neither drifts back.
- [x] 2.4 Rewrite the tool `description` to match: it must not advertise a staleness distinction the tool cannot produce. Say that `failed` reports a past attempt with its time, and that the agent should compare it against when the input set last changed rather than blaming the current data.

## 3. Revise the pinned tests

- [x] 3.1 Update `src/providers/errors.test.ts` for the `provider` arm's new message shape; add a case for a 400 whose body fails the provider error schema (SDK message is the bare reason phrase `Bad Request`) asserting the composed message names workload and status.
- [x] 3.2 Add a case asserting a captured response body appears as a ≤120-character single-lined excerpt, and one asserting an empty reason phrase still yields an identifying message.
- [x] 3.3 Add a classification-invariance test: two failures with the same status and different bodies get the same `type`/`retryable`, differing only in `message`.
- [x] 3.4 Update `src/tools/research/inspect-data-profile.test.ts:137` (which pins the current bare `failed` message). Cover: `failed` carries `failedAt` and non-verdict wording; a row with no recorded time yields `failedAt: null`; no field purports to report input-set staleness; a failure with a surviving prior result is served as `stale`, not `failed`.
- [x] 3.5 Add a regression test for the budget backstop: a `provider`-classified 400 whose response body contains the words "budget exceeded" MUST NOT satisfy `isBudgetExceeded`, while a genuine `budget` arm still does.

## 4. Verify

- [x] 4.1 `tsc -p tsconfig.json` clean.
- [x] 4.2 `bun test` green, with particular attention to any suite matching on `ProviderError.message` text.
- [x] 4.3 Confirm no consumer pattern-matches the `provider` arm's message (`isBudgetExceeded`'s documented message backstop targets the `budget` arm, whose prose is unchanged) — grep before concluding.
- [x] 4.4 End-to-end check against the reported failure: a 400 from the local proxy with a non-conforming body now lands in `cortex_analysis_state.data_profile_error` as something naming the workload and status, not `Bad Request`. Confirm it still fits `profileFailureReason`'s 200-character single-line contract with the most diagnostic content first. Verified through the real chain (real AI SDK anthropic provider → `toProviderError` → `ResultError` → `profileFailureReason` → real Postgres ledger → `inspect_data_profile`): 156 chars, single line, `HTTP 400` and the body's explanation both intact. The running cliproxy was probed and does answer a non-conforming `{"error":"…"}` body, which is what triggers the SDK's statusText fallback; a local server stood in for it to force a 400 rather than the 401 an unauthenticated probe returns.
- [x] 4.5 Run `bun run format:file` on every touched file under `src/`.
- [x] 4.6 `openspec validate data-profile-failure-diagnostics` passes.

## 5. Close the budget-backstop regression

- [x] 5.1 In `src/loop/budget-exceeded.ts`, make `isBudgetExceeded` key on the classified value when one is present: after the existing 402 check, if the value (or anything on its cause chain) is a `ProviderError`, decide on `type === "budget"` and do not run the text patterns. Keep the patterns as the fallback for unclassified throwables, which is the case they were written for.
- [x] 5.2 Comment the ordering constraint: the text heuristic must never outrank a classification the provider layer already made, or a response-body excerpt can self-cancel a step that merely mentioned a budget.
- [x] 5.3 Re-run `bun test` — `sandbox-step` and `execute-analysis` consume this predicate for fatal-error handling.
