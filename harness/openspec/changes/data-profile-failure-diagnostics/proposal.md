## Why

When a data profile fails, the harness discards everything needed to understand why, and then reports the wreckage in a way that misattributes it to the current input set. Both halves showed up in inflexa-ai/inflexa#258, where the profile row read `Data profiling failed and no earlier profile exists: Bad Request.` and the reporter — reasonably — concluded the newly-added files were the problem.

`toProviderError`'s `provider` arm returns `{ type: "provider", retryable, message: detail }` with `detail` forwarded verbatim (`providers/errors.ts:93`). It is the only one of the four arms that adds no context; `auth`, `budget`, and `tenant-blocked` all prefix prose naming the workload and the broken thing (`:73`, `:81`, `:89`). So when the AI SDK cannot parse a 4xx body against the provider's strict error schema it falls back to `message: response.statusText` (`@ai-sdk/provider-utils`), and that bare HTTP reason phrase — `"Bad Request"` — travels intact through `unwrapOrThrow` → `ResultError` (whose `describe` prefers a structured error's `message` over its `type`, `lib/result.ts:60-72`) → `profileFailureReason` → the ledger → the agent. The status code, the workload, the endpoint, and the response body the SDK *did* capture on `APICallError.responseBody` are all still present on `.cause` at the moment the message is composed, and none of them survive. A four-word message is the entire account of a failed run.

Separately, `inspect_data_profile`'s `failed`-with-no-result branch (`tools/research/inspect-data-profile.ts:174-179`) returns just the raw error, phrased as a flat verdict. An agent cannot distinguish "profiling failed on *these* files" from "an old failure is still on the row and nobody has retried it", which is precisely the wrong inference #258 records. The tool cannot resolve that ambiguity by itself — it reads one ledger row, and the current input set lives with the embedder — but it can stop asserting the wrong half of it, and can surface the timestamp that lets the caller decide.

## What Changes

- **The `provider` arm of `ProviderError` carries a diagnosis.** Its message names the workload and the HTTP status alongside the underlying detail, matching the shape the other three arms already use. Classification stays keyed on status only — this changes the message, never the taxonomy or retryability.
- **A bounded excerpt of the provider's response body is preserved.** When the SDK captured a response body (`APICallError.responseBody`), a length-capped excerpt rides in the surfaced message so a proxy-minted or non-conforming error body is readable instead of collapsing to its reason phrase. The cap is **120 characters**, single-lined: the tightest downstream consumer (`data_profile_error`) truncates the whole line at 200, so 120 is the largest round value that still leaves room for the workload, the status, and the reason phrase that precede it.
- **An empty reason phrase never becomes an empty message.** An HTTP/2 hop yields `statusText === ""`, which currently renders as the generic `"Data profiling failed"`; the status-bearing message removes that dead end.
- **`inspect_data_profile` stops implying that a recorded failure is a verdict on the current inputs.** The `failed` variant gains `failedAt` — when the failure was recorded — and says plainly that it describes an earlier attempt whose relationship to the current input files this row cannot establish. It deliberately does **not** report a staleness verdict, because the harness cannot derive one here: the tool reads a single `cortex_analysis_state` row, and the analysis's current input set is embedder knowledge it has no access to. A timestamp is reported instead because it is a fact the row holds and an agent that knows when its inputs last changed can compare the two itself.

- **The budget backstop keys on the classified value, not on message text.** `isBudgetExceeded` (`loop/budget-exceeded.ts:45-49`) falls through to matching `/budget.?exceeded/i` against any error message. Carrying a provider response body into the message means a non-402 whose body merely mentions a budget would now trip it and self-cancel the step as a budget failure. Where a classified `ProviderError` is present its `type` SHALL decide, leaving the text heuristic for the unclassified throwables it was written for.

Not changed: the classification taxonomy, retry policy, `profileFailureReason`'s truncation contract, or the rule that lifecycle states are ok-channel data variants rather than errors.

## Capabilities

### New Capabilities

<!-- None: both changes tighten existing requirements. -->

### Modified Capabilities

- `harness-providers`: the `provider` variant's surfaced message SHALL name the workload and HTTP status and SHALL preserve a bounded response-body excerpt when one was captured, so a non-conforming error body does not degrade to a bare HTTP reason phrase. Classification remains status-keyed and unchanged.
- `data-profile-init`: `inspect_data_profile`'s `failed` state SHALL report the failure's recorded time and SHALL NOT imply that it describes the analysis's current input files, nor expose a staleness verdict the harness cannot derive.

## Impact

- `harness/src/providers/errors.ts` — the `provider` arm of `toProviderError`; a response-body reader on the cause chain.
- `harness/src/tools/research/inspect-data-profile.ts` — the `failed` output variant and the staleness derivation currently gated behind a present `result`.
- Consumers reading `InspectDataProfileOutput` must tolerate the additive fields; the variants stay in the ok channel.
- `harness/src/tasks/data-profile.ts` is untouched — `profileFailureReason` keeps its 200-char single-line contract, and simply has something worth truncating.
- Tests: `providers/errors.test.ts` asserts message shapes for the classified arms; `tools/research/inspect-data-profile.test.ts:137` pins the current bare `failed` message and must be revised.
- Companion cli change: `stage-inputs-independent-of-profile` fixes the staging wedge that made a stale failure so consequential. Independent of this change; neither blocks the other.
- Adjacent, non-overlapping: the in-flight `conversation-unstaged-data-guidance` change edits conversation prompt text only and touches none of these code paths.
