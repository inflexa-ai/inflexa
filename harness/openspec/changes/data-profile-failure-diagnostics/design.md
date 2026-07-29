## Context

Two independent narrowings turn a failed data profile into an unreadable, misattributed result.

The first is one line. `toProviderError` (`src/providers/errors.ts`) has four arms; three of them compose prose around the underlying detail (`:73`, `:81`, `:89`), and the `provider` arm returns `{ type: "provider", retryable, message: detail }` (`:93`) with `detail` forwarded raw. The AI SDK, when a 4xx body fails to parse against the provider's error schema, sets its error message to `response.statusText`. Those two facts compose into a four-word account of a failed run: `"Bad Request"`. Everything needed to diagnose it — the status, the workload, the endpoint, and the response body the SDK captured on `APICallError.responseBody` — is still reachable on the `cause` chain at the moment the message is built, and is discarded there. Downstream nothing can recover it: `ResultError.describe` prefers a structured error's `message` over its `type` (`src/lib/result.ts:60-72`), and `profileFailureReason` (`src/tasks/data-profile.ts:658-662`) truncates whatever it is handed.

The second is a phrasing that overclaims. The `failed`-with-no-result branch (`src/tools/research/inspect-data-profile.ts:174-179`) returns the raw error and nothing else, reading as a verdict on whatever files the agent currently holds. It is not one — it is a record of an earlier attempt — and an agent reading `failed: Bad Request` reasonably assumes the former. The tool cannot settle the question itself (see Decision 4), but it can stop asserting the wrong answer and hand over the timestamp that lets the caller settle it.

## Goals / Non-Goals

**Goals:**

- A `provider`-classified failure carries enough context to identify what failed and where, without opening the logs.
- A non-conforming or empty provider error body degrades to something better than an HTTP reason phrase.
- `inspect_data_profile` stops presenting a recorded failure as a verdict on the current inputs, and reports the fact (its timestamp) that lets a caller judge for itself.
- No agent-facing field or description promises a distinction the implementation cannot produce.

**Non-Goals:**

- Changing the error taxonomy, the status-keyed classification, or retryability. `harness-providers` fixes these deliberately (classification "SHALL key on the HTTP status only, never on provider message text"), and message composition must not become a classification input.
- Changing `profileFailureReason`'s single-line 200-character contract. It is correct — `data_profile_error` is surfaced verbatim to users. It has simply had nothing worth truncating.
- Logging changes. The `Logger` seam already receives the full error at `data-profile.ts:455`; this is about what reaches the *agent and the user*.
- Retry or recovery policy for failed profiles. The companion cli change owns that.

## Decisions

### 1. The `provider` arm composes, like the other three

Give the `provider` arm the shape its siblings already have: name the workload, name the HTTP status when one was extractable, then the underlying detail. `classifyProviderError` already walks the cause chain for a status (`extractStatus`, `:136-145`), so the status is in hand at composition time with no new traversal.

*Alternative — decorate further downstream, in `profileFailureReason`.* Rejected: it would only fix the data-profile path, leaving every other `ProviderError` consumer with the bare message, and `profileFailureReason` receives an already-flattened `Error` with the cause chain no longer meaningful to it.

*Alternative — leave the message and require consumers to read `.cause`.* Rejected: the value is a `DomainError` whose `message` is by contract the human-readable channel, and `ResultError.describe` will keep preferring it. Consumers that stringify — which is all of them — would still get the bare phrase.

### 2. A bounded response-body excerpt rides in the message

When the cause chain carries a captured response body, append a length-capped, single-lined excerpt. This is what recovers a proxy-minted 400 whose body explains itself but does not match the Anthropic envelope — the exact shape that produced `"Bad Request"`.

The cap is **120 characters**, single-lined, and is composed *here* rather than left to `profileFailureReason`'s 200-character truncation, for two reasons: other `ProviderError` consumers have no such truncation, and truncating at the far end would let the body crowd out the status and workload that precede it.

120 is derived, not picked: the tightest downstream consumer truncates the whole line at 200, and a workload label plus `HTTP 400` plus a reason phrase runs to roughly 80, so 120 is the largest round value that cannot evict the lead. The constant is the harness's own rather than shared with `PROFILE_ERROR_MAX_LEN` (`data-profile.ts:657`) — that one bounds a ledger column, this one bounds a message many non-ledger consumers read, and coupling them would make either one unmovable.

*Alternative — attach the body as a structured field instead of in the message.* Better in principle, and rejected only because every current consumer path (`describe` → `Error.message` → `profileFailureReason` → a `varchar` ledger column) is a string funnel. A structured field would be dropped at the first hop. Worth revisiting if that funnel is ever widened.

### 3. Status-bearing messages remove the empty-reason-phrase dead end

An HTTP/2 hop yields `statusText === ""`, which today produces an empty detail and renders as the generic fallback `"Data profiling failed"`. Once the status leads the message, an empty detail is no longer load-bearing — the message still identifies the failure.

### 4. Report the failure's timestamp; do not report a staleness verdict

The original premise of this decision was wrong and is corrected here. It assumed `seedInputFileIds` let the tool compare a failure against the analysis's current inputs. It does not, for two independent reasons, both verified:

- `upsertAnalysis` (`src/state/analyses.ts:45`) writes `seed_input_file_ids = COALESCE(EXCLUDED..., existing)`, so any caller passing a non-null set **overwrites** it. The column is "the most recently seeded set", not a snapshot of what a given attempt covered.
- More fundamentally, there is no second comparand. `FailedOutput` is reached only under `if (!result)`, so `result.inputFileIds` is null by construction, and the tool's only inputs are a pool and a resource id resolving to one `cortex_analysis_state` row. The analysis's *current* input set is the embedder's knowledge — the CLI derives it from its own database and the filesystem. The harness cannot see it.

So a tri-state `inputSetSinceFailure` is underivable: every branch but `"unknown"` is unreachable. Shipping it would mean a required field that is constant on the only path that returns it, plus a tool description advertising three values the implementation can never produce. That is worse than saying nothing — the exact "constant field carries no information" argument that keeps this field off `AbsentOutput` applies here with equal force, and agent-facing description text is the layer that cannot be typechecked.

The variant therefore carries `failedAt: string | null` (from the row's recorded completion time) and a message stating that the failure describes an earlier attempt whose relationship to the current inputs this row cannot establish. The timestamp is a fact the row genuinely holds, it is not constant, and it is actionable: an agent that knows when it last changed the input set can draw the comparison the harness cannot.

*Alternative — record what each failed attempt covered in a new column.* This is the only way to make a real tri-state, and it is deliberately declined: it is a schema change to the harness's ledger driven by a reporting nicety, and once the embedder re-profiles on drift the durable `failed` state is the same-inputs one anyway. If a host ever needs the verdict, that column is the honest way to get it.

*Alternative — keep the field, always `"unknown"`.* Rejected: it is the constant-field anti-pattern, and the description would have to either lie about the other two values or explain that they never occur.

### 5. The budget backstop keys on the classified value

`isBudgetExceeded` (`src/loop/budget-exceeded.ts:45-49`) checks for a 402 on the cause chain and then falls through to matching `/budget.?exceeded/i` against the message. Decision 2 puts a provider response body into that message, so a 400 whose body happens to mention a budget would newly trip the backstop — and callers treat that as fatal (`sandbox-step.ts` self-cancels, `execute-analysis.ts` re-raises as a budget throw). Misclassifying a non-retryable 400 as a budget stop is a real regression, introduced by this change.

The fix keeps the heuristic where it belongs: when the value is, or wraps, a classified `ProviderError`, its `type` decides. The text patterns remain for unclassified throwables, which is the case they were written for — the backstop's own documentation calls out "paths where no statusCode is attached".

*Alternative — sanitize budget-like phrases out of the excerpt.* Rejected: lossy, surprising, and it would corrupt the diagnostic content this change exists to preserve.

## Risks / Trade-offs

- **Longer messages could crowd the 200-character ledger column** → Ordering is deliberate: workload and status lead, the body excerpt trails, so truncation eats the least diagnostic part first. Net strictly better than four words.
- **A response body could contain sensitive material** → It is a provider error body, already surfaced to the operator via the `Logger` seam. The excerpt is capped and single-lined; it introduces no new sink, since `data_profile_error` was already user-visible.
- **A test asserts the current bare message** → `inspect-data-profile.test.ts:137` pins the `failed` message text and `providers/errors.test.ts` pins arm shapes. Both are the contract being changed; they are revised, not worked around.
- **Message text is not a classification input, and must not become one** → `harness-providers` requires status-only classification. Composition happens strictly after `classifyProviderError` returns, so the two cannot couple. Worth an explicit test that a message change does not move an arm.
- **Consumers pattern-matching on message text** → Verified by grep, not assumed. `isBudgetExceeded` (`loop/budget-exceeded.ts:45-49`) matches any message, not just the `budget` arm's, so the body excerpt could newly trip it; Decision 5 closes that. `CONNECTION_ERROR_PATTERN` (`providers/errors.ts`) runs on the original throwable inside `classifyProviderError`, strictly before composition, so it cannot be fed by the excerpt. No other consumer matches on `ProviderError.message`.

## Migration Plan

No data migration and no schema change — every value reported is already recorded on the row. `InspectDataProfileOutput` gains `failedAt` on one variant, additive for consumers that switch on `state`. Rollback is a code revert.
