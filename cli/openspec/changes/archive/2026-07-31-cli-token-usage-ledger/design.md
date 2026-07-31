## Context

The harness emits one `LlmUsageRecord` per completed LLM call through the `UsageRecorder` seam (`src/billing/usage-recorder.ts` in `@inflexa-ai/harness`). The record carries `recordKey`, `agentId`, `callPath`, `scope`, optional `runId`/`stepId`, optional `requestedModelId`/`servedModelId`, and a `ChatUsage` whose five token fields are each independently optional. Two contract terms shape everything below:

- **The harness guarantees key stability, not at-most-once delivery.** A replayed durable workflow body re-fires `record` with a byte-identical `recordKey`. Consumers MUST upsert.
- **`record` MUST NOT throw and MUST NOT block.** The loop neither awaits nor guards it.

The CLI today wires none of it. Verified current state: `usageRecorder` appears zero times in `cli/src`; the composition root builds its deps bags at `src/modules/harness/runtime.ts:914` (`CoreWorkflowDeps`) and `:943` (`ConversationAssemblyDeps`) without it. The shared turn engine reads `result.finish` at exactly one place — `src/modules/harness/turn.ts:193`, testing `reason === "aborted"` — and its intermediate `RunPhase` type (`turn.ts:139`) has no field to carry usage forward, so `finish.usage`/`finish.turnUsage` are unreachable after `turn.ts:196`. On the run-event stream, `src/tui/hooks/activity_panel.ts:263` dispatches a single `if (part.type === "data-step-activity")`; `data-step-usage` and `RunCompletedPart.usage` have no reader anywhere in `cli/src`.

Attribution is complete enough to key a ledger on. `Scope`'s analysis variant carries `analysisId` and an optional `threadId`, and the CLI populates both for chat: `buildChatSession` sets `scope: { kind: "analysis", analysisId, threadId }` (`turn.ts:132`). Run-path calls carry `runId`/`stepId` from the `RunFrame`. So every record is attributable to an analysis; chat records additionally to a thread, run records additionally to a run and step.

## Goals / Non-Goals

**Goals:**
- Durably record every LLM call the CLI's harness makes, idempotently under replay.
- Preserve the harness's absent-means-not-reported discipline through persistence and display.
- Answer the issue's three questions locally: what did this turn cost, what has this analysis cost, and which model actually served each call.
- Keep `record` cheap enough to sit in the agent loop's hot path, and incapable of failing the turn.

**Non-Goals:**
- Pricing, currency, or cost estimation. Tokens only.
- Consuming the run-event stream's `data-step-usage` part or `RunCompletedPart.usage` (Decision 3).
- Per-turn historical attribution. Chat records carry a thread, not a turn id; the live turn total comes from the finish rollup, and the ledger aggregates at analysis/thread/run granularity.
- Changing the harness. Every fact this design leans on is already merged.

## Decisions

### Decision 1: The ledger is CLI-owned SQLite, not the harness's Postgres

Usage rows go in the CLI's local SQLite (`env.dbPath`), as a new table beside `anchors`/`projects`/`analyses`/`analysis_inputs`.

*Why:* three independent reasons agree. (a) The repository's boundary rule says an embedder "supplies values at its composition root … and never owns or redefines what the harness does" — a CLI-owned table inside the harness's own database is precisely the embedder redefining harness storage. (b) `inflexa usage` is a read-only report; sourcing it from Postgres would make it require a full harness boot, and the harness's Postgres is provisioned/started on demand. A local report must work when the engine is cold. (c) SQLite is already the CLI's local-first store, opened as a process-wide singleton with WAL (`src/db/primary.ts:10-30`), and every process that writes usage (the TUI, a headless `inflexa run`) opens the same file.

*Alternative considered:* a table in the harness's Postgres, which would put usage beside `cortex_runs` and survive a wiped local database. Rejected on (a) — the boundary is the point of the whole two-package design — and because it inverts the availability story: the durable engine's own recovery would be a prerequisite for reading a report about tokens already spent.

### Decision 2: `recordKey` is the primary key, and the write is `INSERT … ON CONFLICT DO UPDATE`

The table has no synthetic `id`. `record_key TEXT PRIMARY KEY` is the identity, and the write upserts on it.

*Why:* the record's identity is the harness's key by construction — minting a second identity alongside it would create two things that must agree about what "the same call" is. The house rule that entity tables carry an `id/created_at/updated_at` triple already has a documented exception for rows that are not entities (`analysis_inputs`, "a ref is not an entity"); a usage record is an observation, and its key is given. `DO UPDATE` over `DO NOTHING` follows the harness contract literally ("consumers MUST upsert on this key"): on a pure replay the two are equivalent because the replayed body reports the cached call's identical figures, but on a genuine step *retry* that re-executes the call for real, last-writer-wins reflects the retry's actual spend where `DO NOTHING` would pin the abandoned attempt's.

`recorded_at` is deliberately excluded from the conflict update, so the ledger's time axis records when the work happened rather than when a recovery replayed it. The harness stamps no timestamp on the record (its own design decision), so arrival time at the sink is the only clock available and the first observation is the truest one.

### Decision 3: The ledger is the single source; the run-event usage parts stay unconsumed

`data-step-usage` and `RunCompletedPart.usage` are not read. Per-step and per-run totals are computed from the ledger by summing rows with that `run_id`/`step_id`.

*Why:* the ledger is strictly more granular — a step rollup is the sum of that step's call records, and a run rollup the sum of its steps' — so the parts are derivable from the ledger and never the reverse. Consuming both would make two writers of the same number with different arrival paths and different replay semantics. The CLI has already settled this exact question once and written down the rule: run completion is detected from the polled snapshot rather than the bus event because "one source with one rule beats two sources that must agree" (`src/tui/hooks/run_completion.ts:18-22`). This follows it.

*Consequence, accepted:* a run launched by a *separate* `inflexa run` process still lands in the shared SQLite file, so its usage is visible to the TUI — the parts would have bought nothing there either.

### Decision 4: The recorder writes synchronously and swallows its own failures

The realization performs one synchronous upsert per record, wrapped so no error escapes; failures are logged through the structured logger at `warn` and otherwise ignored.

*Why:* `bun:sqlite` is synchronous, and so is every existing write in `src/db/primary_mutation.ts` — an asynchronous buffered writer would be the only async store in the CLI, and it would trade guaranteed durability (a crash loses the buffer) for a saving measured in microseconds on a single indexed insert against a local WAL file. Records arrive at LLM-call cadence — seconds apart per loop — not at event-stream cadence.

Swallowing is not laziness, it is the contract: `record` must not throw, and a usage-ledger fault must never be able to fail a turn that otherwise succeeded. The seam is the boundary where that guarantee is realized, which is why the `tryMutation` `Result` is consumed there rather than propagated.

*Risk acknowledged:* the connection sets `busy_timeout = 5000` (`src/db/primary.ts:19`), so a write contending with another process's write can in principle block. This is the same exposure every existing CLI write already carries on the same connection, and WAL keeps the contention window to the duration of a single-row insert.

### Decision 5: Token columns are nullable; absent is never zero

Each of the five token fields is a nullable INTEGER, written as `NULL` when the provider did not report it.

*Why:* this is the harness's central usage discipline ("Unreported figures stay absent, never zeroed") and persistence is exactly where it is easiest to lose. `NOT NULL DEFAULT 0` would silently convert "this provider does not report cache reads" into "this provider reported zero cache reads" — which is the difference between an unknown and a measurement, and the reason the harness never emits an all-zero rollup. Aggregates therefore use `SUM()`, which ignores NULLs and itself returns NULL for an all-absent group, preserving the distinction at the read side too.

What these five quantities mean once they reach a surface — and why they must never be added together — is Decision 10.

### Decision 6: Scope is stored as `(scope_kind, scope_id)`, with no foreign key

Two columns hold the scope discriminant and its workload id, rather than a single `analysis_id`.

*Why:* `Scope` is a two-variant union and the CLI must not silently drop the variant it does not currently launch. Storing the discriminant makes the mapping total, and a per-analysis query simply constrains `scope_kind = 'analysis'`.

No foreign key to `analyses(id)`: scope ids are minted harness-side and include synthetic probe ids the local table will never hold (`analysisId: "embedding-boot-probe"` at `runtime.ts:249`, `"embedding-setup-verify"` at `modules/embedding/setup.ts:269`). A foreign key would make the recorder throw on exactly the rows it must not fail on, and the recorder is contractually forbidden to throw. `thread_id` is denormalized out of the scope for the same reason it rides in scope harness-side: it is attribution, not a relation.

### Decision 7: The turn's live total comes from `finish.turnUsage`, not from the ledger

`TurnOutcome` gains an optional turn-usage field, filled from `AgentFinish.turnUsage`.

*Why:* the ledger cannot answer "what did *this turn* cost" — chat-path records carry a thread, not a turn id, because outside a `RunFrame` the harness mints a fresh UUID key per call rather than a composed one. The harness already computes the whole-turn total, sub-agents included, precisely for this surface, and by its own contract the turn root is the loop whose options carry no accumulator — which `turn.ts:184` is, since it passes no `turnUsage`. Reading it costs nothing and is definitionally correct.

This is not a second source of truth in the Decision 3 sense: the finish rollup and the ledger are two aggregations of the same per-call capture, at different granularities, which the harness's own spec states outright ("the counters, the records, and the finish rollups are three surfaces over the same per-call capture"). The turn total answers a question the ledger structurally cannot.

### Decision 8: `inflexa usage` is `{ kind: "auto", safeFlags: ["analysis"] }`

The command reports and never writes; its one option selects which analysis to report on.

*Why:* the `auto` bar is that "every value it can carry leaves the command read-only". `--analysis <ref>` resolves an existing analysis for reading and cannot change what the command does to the system; it is the same read-only selector shape already carried by `ls --project`.

The CLI's convention is to ask the user for a new command's classification rather than guess, and this design does not get to waive that. The classification above is a proposal, not a settled fact: implementation SHALL confirm it with the user before the command is registered (a task carries this), and until then `auto` is the reviewable default rather than a silent one. Recording it as a decision is what makes the guess visible enough to be corrected; leaving it to the implementer would have buried it in a diff.

### Decision 9: The sidebar section reads SQLite directly, on the existing local-read pattern

The USAGE section reads the ledger synchronously inside a memo, refreshed by the message count the sidebar already receives and by the `run.observed` bus event it already has a subscription for.

*Why:* the sidebar has two established patterns, and this fits the older one exactly. Its ANALYSIS section already reads SQLite synchronously in a memo and re-runs on a bus tick (`sidebar.tsx:276-313`, subscription at `:302`), while DATA PROFILE and RUNS go through `sidebar_live.ts`'s seam-injected Postgres reads with a bounded poll. A local SQLite aggregate needs neither a seam nor a poll. Reusing the local pattern adds no new refresh machinery, and the two existing triggers cover both ways usage grows: a turn completing changes `messageCount`, and a run progressing emits `run.observed`.

The section's arrival also retires a comment the file currently carries — that there is deliberately no token-cost section because "no real accounting source exists to render" (`sidebar.tsx:254-255`). That statement stops being true with this change, and leaving it would misdirect the next reader.

### Decision 10: No surface invents a total; input and output are reported as two figures

Every surface reports `inputTokens` and `outputTokens` as two distinct figures. The other three quantities are rendered as breakdowns beneath them where there is room, never added to them, and no surface computes a single summed "tokens" number.

*Why:* the five quantities are not addable, and the mapping proves it rather than merely suggesting it. `toChatUsage` (`harness/src/providers/ai-sdk.ts:242-251`) fills `cacheCreationInputTokens` and `cacheReadInputTokens` from the SDK's `inputTokenDetails`, and `reasoningTokens` from its `outputTokenDetails` — they are *details of* the two headline counts, not siblings of them. Summing all five would count a cached prefix twice and reasoning twice. The harness's own agent-loop spec states the same relationship from the other direction when it defines cache hit rate as `cache_read_tokens / input_tokens`, "the harness's `inputTokens` being the total billed prefix, cache reads included".

It is equally deliberate that `ChatUsage` carries no `totalTokens` field even though the AI SDK offers one: a total is a display choice with provider-specific meaning, and the harness declines to make it. The CLI declines too. "12.4k in / 3.1k out" is unambiguous, needs no footnote, and cannot silently double-count; a single "15.5k tokens" is a number whose meaning changes with the provider's cache reporting.

*Alternative considered:* reporting `inputTokens + outputTokens` as one figure, which is what the SDK's `totalTokens` means and is compact enough for the sidebar's 40 columns. Rejected because the compactness is worth less than the property that every figure on screen is one the provider actually reported — the same reason the absent/zero distinction is preserved everywhere else in this design.

### Decision 11: Usage rows outlive the analysis they attribute to

Deleting a local analysis SHALL NOT delete its usage rows, and no retention or pruning policy is introduced.

*Why:* the ledger records tokens that were actually spent, and removing the local record of an analysis does not un-spend them; a ledger that silently shrinks when unrelated bookkeeping happens is not a ledger. This also follows from Decision 6 — there is no foreign key to cascade from, and adding one purely to enable a cascade would reintroduce the failure mode that decision exists to avoid. Growth is not a concern at this granularity: rows are one per LLM call and a few hundred bytes, so even a heavy year of use stays comfortably within a local SQLite file.

*Consequence, accepted:* an orphaned row's `scope_id` names an analysis the CLI can no longer resolve to a name. Reports group by the id, which stays meaningful, and the `usage` command reports only the analysis it was asked about, so orphans never intrude on a live report.

### Decision 12: The CLI reads `AgentFinish` directly and frames no `FinishEvent`

The turn's total is read off the `runAgent` return. The harness's `FinishEvent` contract type is not constructed.

*Why:* `FinishEvent` exists for a host that publishes a turn as an event stream, and the harness ships no producer for it precisely because framing it is a host's choice. The CLI's turn engine is a function that returns a value, and both of its surfaces — the TUI conversation store and the REPL printer — consume that return. Constructing an event no subscriber reads, to carry a number the caller already holds, would be ceremony that adds a shape to keep in sync with nothing on the other end. If the CLI ever grows a genuine turn-event stream, framing it there is a smaller change than unwinding an unused one now.

## Risks / Trade-offs

- **A wiped local database loses history.** → Accepted and inherent to Decision 1. The ledger is a local observability record, not a billing document; nothing downstream depends on its completeness, and the harness's OTel counters remain an independent surface.
- **Records from a genuine step retry overwrite the abandoned attempt's figures**, undercounting the true spend for that key. → Accepted in Decision 2. The alternative (summing) double-counts on every ordinary replay, which is far more frequent than a retry. The harness's key contract admits no way to distinguish the two at the sink.
- **A slow or locked database could stall the agent loop** for up to the 5s busy timeout. → Mitigated by WAL and single-row writes; equal to the exposure of every existing CLI write. If it ever bites, the fix is a buffered writer behind the same seam realization, with no change above it.
- **The `auto` policy on a new command is a judgment call** the house rules say to ask about. → Mitigated by recording it as Decision 8 with its justification, and by the CI test that fails if `safeFlags` names an option that does not exist. Reclassifying later is a one-line change plus a snapshot update.
- **Sidebar refresh is edge-driven, not continuous.** A background run's tokens appear at the next turn boundary or run observation, not the instant they are spent. → Accepted: the section reports a cumulative total, where lag is not misleading, and both triggers already exist. A poll would add a timer for a number that changes at LLM-call cadence.
