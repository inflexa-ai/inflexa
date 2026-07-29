## Context

`prepareChatTurn` currently assembles a cache-stable history prefix followed by ephemeral analysis context, rendered working memory, and the current user message. Run completion is intentionally pull-only: workflows update `cortex_runs` and the DBOS-backed stream, while the conversation thread receives no completion message. Consequently, a later conversation turn has no fresh statement of which analysis runs are still non-terminal.

`inspect_run` reads the same run ledger. Its list mode is capped and ordered only by `started_at`, so a sufficiently old running run can fall behind newer terminal history. Its targeted mode exposes the ledger's nested `status`, step rows, and output paths without a top-level interpretation of whether results are ready. It also has no bounded alternative to repeated polling.

The run ledger remains the harness-owned source of truth. The design must preserve the cacheable message prefix, avoid new persistence, stay host-agnostic, respect request cancellation, and remain safe when `inspect_run` is used by a sandbox agent from inside the run it inspects.

## Goals / Non-Goals

**Goals:**

- Give the conversation agent a fresh, analysis-wide view of non-terminal runs on every turn.
- Make absence, suspension, truncation, and temporary unavailability explicit.
- Make list inspection active-first and page-aware.
- Make targeted inspection state unambiguous and allow one bounded wait for terminal state.
- Prevent same-turn inspect loops through tool results and prompt rules.

**Non-Goals:**

- Automatically invoke the conversation agent when a workflow completes.
- Persist run activity into thread history or working memory.
- Infer that a run is stalled from its age or reconcile `cortex_runs` against DBOS internals.
- Change workflow execution, run-status persistence, the run stream, or the CLI's presentation behavior.
- Add database tables, columns, notifications, or dependencies.

## Decisions

### D1. Inject an ephemeral Run Activity tail message

Chat-turn preparation will read analysis-wide run activity from `cortex_runs` and render a `[Run Activity]` user message between analysis context and working memory:

```text
history
[Analysis Context]
[Run Activity]
[Working Memory]
current user message
```

The snapshot distinguishes `running` from `suspended_insufficient_funds`, carries full run and plan ids, and renders both the absolute `startedAt` timestamp and a compact age computed at preparation time. It explicitly renders the empty state. A read failure degrades to an unavailable statement rather than silently omitting the entry.

The renderer will cap detailed non-terminal rows at 20 and include the true total and omitted count when the cap is exceeded. This bounds the every-turn token cost while ensuring the model knows the snapshot is incomplete.

The snapshot is assembled afresh and is never passed to `appendTurn`. This follows the existing analysis-context and working-memory tail pattern and leaves the system/history cache prefix stable.

Alternatives considered:

- Persist completion messages into conversation history: rejected because it reverses the pull-only result model and introduces unsolicited, replay-sensitive chat writes.
- Put run state in working memory: rejected because run lifecycle is derived operational state, not agent-authored interpretation.
- Scope activity to the current thread: rejected because the conversation agent is analysis-scoped and must see work launched by another thread or by an embedder surface.

### D2. Make list inspection active-first and explicitly bounded

Parameterless `inspect_run` will use one deterministic order:

1. `running`, newest first;
2. `suspended_insufficient_funds`, newest first;
3. terminal statuses, newest first.

List mode will accept optional `page` and `pageSize` inputs, defaulting to page 1 and 50 rows, with `pageSize` capped at 100. Its result will preserve the `runs` collection and add `total`, `page`, `pageSize`, and `hasMore`. Ordering happens in SQL before limit/offset, so an old non-terminal run cannot be hidden by newer terminal history on the first page. If non-terminal runs alone exceed the page size, `hasMore` makes the remaining rows discoverable rather than silently absent.

Alternatives considered:

- Return separate active and terminal arrays: rejected to avoid an unnecessary model-facing shape replacement; explicit ordering and per-row status provide the needed distinction.
- Load the existing capped chronological result and sort it in memory: rejected because a run excluded by the database limit cannot be recovered by post-processing.

### D3. Return a top-level targeted inspection state

Targeted inspection will return `inspectionState` as one of:

- `not_found`;
- `in_progress` for `run.status === "running"`;
- `suspended` for `run.status === "suspended_insufficient_funds"`;
- `terminal` for completed, partial, failed, or canceled runs.

Every found result carries the formatted run. An in-progress result also carries `elapsedMs` and direct prose that results are not ready. Suspended results explain that waiting cannot make progress until the run is resumed. Step output and synthesis paths are advertised only for terminal inspection, preventing a partially populated response from being interpreted as a finished result.

The underlying ledger status remains present; `inspectionState` interprets readiness without erasing the domain status.

### D4. Bound waiting in one parameter

`waitForTerminalSeconds` is an optional integer from 1 through 30 and is valid only with `runId`. When supplied for a running run, `inspect_run` re-reads the ledger about once per second until the run is no longer running, the cutoff is reached, or `ctx.signal` aborts.

Terminal, suspended, and missing runs return immediately. Reaching the cutoff is a successful `in_progress` result with wait metadata including `requestedSeconds` and `cutoffReached: true`; it is not a tool error. Cancellation stops promptly and follows the loop's existing fatal-cancellation path.

When a `RunSession` calls `inspect_run` on its own `runFrame.runId`, waiting is refused with an immediate in-progress explanation: the enclosing run cannot become terminal while its current step is blocked waiting for itself.

The wait stays a bounded read loop over the run ledger. PostgreSQL `LISTEN/NOTIFY` was rejected because terminal writes currently publish no database notification and adding a second completion channel would expand the lifecycle surface. Direct DBOS result waiting was rejected because `inspect_run` is a ledger reader and the durability engine remains quarantined behind harness seams.

### D5. Reinforce asynchronous behavior at launch and in the prompt

`execute_analysis` will return the run id with `status: "in_progress"` so the same agent turn does not need an immediate inspection to learn whether the newly launched workflow is done.

The conversation prompt and `inspect_run` description will permit a bounded wait only when the user explicitly wants to wait, require at most one bounded wait in a turn, and require the agent to report and stop when the cutoff returns `in_progress`. The existing instruction that workflows run autonomously remains; the new rule replaces the absolute prohibition on waiting with a constrained, user-directed mechanism.

### D6. Preserve pull-only completion

Workflow completion continues to update `cortex_runs` and the run stream only. The UI may notify the user, but neither the UI nor harness completion path starts a new conversation-agent turn. A future autonomous post-run interpretation would be a separate durable capability with its own idempotency and destination contract.

## Risks / Trade-offs

- [A run row can remain `running` after an unrelated lifecycle defect] → Report the ledger truth and stop after the wait cutoff; DBOS reconciliation is explicitly separate work.
- [The activity snapshot adds tokens to every active-analysis turn] → Render no terminal history, cap detailed non-terminal rows at 20, and keep the empty representation compact.
- [Polling adds repeated database reads] → Cap waiting at 30 seconds with an approximately one-second interval and perform it only when explicitly requested.
- [Tool response additions can affect prompt behavior] → Preserve existing run fields and list collection while adding explicit state and pagination metadata; cover both tool descriptions and model-visible variants with tests.
- [A run can transition between the final run read and step read] → Wait only on the run row, then perform one final formatted inspection; the ledger's terminal transition is the readiness gate.

## Migration Plan

No data migration is required. Deploy the query, tool, chat-tail, and prompt changes together so the new prompt references only inputs and outputs that exist in the same build. Rollback consists of reverting those source changes; persisted run and thread rows remain compatible.

## Open Questions

None.
