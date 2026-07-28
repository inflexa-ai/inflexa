## Context

The harness exposes exactly one host-facing view of a run in progress: the optional `emitProvenance` dep on `ExecuteAnalysisDeps` (`src/workflows/execute-analysis.ts:287`), whose three arms exist to close a signed provenance chain. It fires `run_started`, `step_completed`, and `run_completed` — no step-started edge, no agent identity, no step name, no view of the run's shape. It is deliberately invoked outside `DBOS.runStep` so body re-execution on recovery re-fires it, with idempotency pushed onto the consumer.

Everything richer already exists, on the DBOS `"events"` stream: `data-dag-state`, `data-step-activity`, `data-step-file-tree` and the rest of the eighteen typed parts in `src/contracts/chat-parts.ts`. That stream has no reader on the OSS side — no `readStream` call anywhere in `src/` outside tests, and no barrel export — and building one is a separate, larger piece of work tracked as inflexa-ai/inflexa#247.

The embedder therefore substitutes a five-second SQL poll over `cortex_runs` and `cortex_step_executions`, which is why inflexa-ai/inflexa#244 asks to know "what tasks were being worked on" and #241 reports never noticing a run finish. This change gives the host two narrow seams that need no stream reader.

Two constraints shape every decision below:

- **DBOS body re-execution.** Workflow bodies replay on recovery. Anything invoked directly from the body fires again; anything wrapped in `DBOS.runStep` replays from cache and does *not*.
- **The embedder cannot import `@dbos-inc/dbos-sdk`.** A second copy forks the SDK's module-singleton state, so every DBOS capability the host needs must cross the barrel as a harness export.

## Goals / Non-Goals

**Goals:**
- Let a host observe a run's state as it changes, richly enough to name the work in progress, with no stream reader.
- Let a host record a run's outcome into the conversation thread without corrupting turn structure.
- Keep every seam optional and additive: an embedder that ignores both behaves exactly as today.

**Non-Goals:**
- Reading the DBOS `"events"` stream, or exposing any of its eleven workflow-emitted parts (#247).
- Waking the conversation agent when a run lands, or injecting run state into `prepareChatTurn` (#248).
- Host-initiated run cancellation (#250) — see D8 for why it was extracted rather than carried here.
- Changing `emitProvenance`, `RunProvenanceEvent`, or the provenance contract in any way.
- Emitting sub-step detail (tool calls, file trees, model rounds). The seam stops at step granularity; below that is the stream's job.
- Any new `ThreadHistory` method. The store's "two methods, by design — no generic row insert" rule stands.

## Decisions

**D1 — `observeRun` carries a snapshot, not granular events.** Each invocation hands the host the run id, its lifecycle status, and the complete per-step state at that moment. The alternative — `step_started` / `step_completed` / … events mirroring `emitProvenance` — was rejected on replay grounds. Body re-execution re-fires whatever the body calls, so a granular stream forces every consumer to reconstruct ordering and dedupe by identity. A **re-fired snapshot is idempotent by construction**: latest-wins, and the host's UI state is a pure function of the newest snapshot it has seen. This is the same fold-on-read discipline `data-step-activity` already uses ("stable id per (runId, stepId) so the run-stream fold collapses every phase transition latest-wins"). It also means a host that drops a callback loses nothing permanent — the next transition re-states the whole truth.

**D2 — The seam is fed from the existing `emitDagSnapshot()` call sites, plus the run-start and terminal boundaries.** Those eight sites (`execute-analysis.ts:981, 995, 1025, 1069, 1087, 1104, 1122, 1148`) are already the complete set of run-state transitions — that is what they exist for. Adding new instrumentation points would create a second, drifting definition of "a transition happened". Rejected alternative: instrument step dispatch and settlement independently, which would have to be kept in sync with the DAG emission by hand.

**D3 — `observeRun` is a separate dep, not a fourth `RunProvenanceEvent` arm.** Provenance is a signed, hash-chained record with a single-writer lock on the host side; run observation is a cosmetic, lossy-tolerant UI channel. Overloading one callback would couple a UI refresh to the chain's write discipline and force provenance to carry fields (step names, agent ids, per-step status) it has no business recording. Two deps, one payload shape each, no shared vocabulary.

**D4 — `observeRun` mirrors `emitProvenance`'s invocation and isolation discipline exactly.** Called directly from the body (never inside `DBOS.runStep`) so recovery re-fires it; wrapped in a guard that logs and swallows a throwing host callback, because the harness is host-agnostic and cannot assume the callback is total. This is a deliberate copy of `emitProvenanceGuarded` (`execute-analysis.ts:304-313`) rather than a shared helper: the two seams carry unrelated payloads and must be independently removable, and a shared guard would make one seam's logging namespace lie about the other.

**D5 — `emitDagSnapshot` populates `name` from the snapshotted plan step, not from its own iteration variable.** It currently sets `name: s.id`, so the contract advertises a human name and delivers a slug. The subtlety is which input holds the name: `input.steps` is typed `readonly PlanStep[]` (`:122`) where `PlanStep` is the **scheduler's** structural type — `{ id, depends_on }` and nothing else (`execute-analysis-scheduler.ts:27-30`) — deliberately narrow so the scheduler depends on no plan vocabulary, and `executePlan` projects it down to exactly those two fields at the async edge (`execute-plan.ts:217-220`). The full plan step rides separately on `input.planStepById` (`:133`, `Readonly<Record<string, AnalysisStep>>`), whose `name` is a required string and which the dispatch path already reads by step id (`:334`). So the emitter joins through `planStepById` and the scheduler's projection stays untouched. This is scoped as a fix rather than left alone because the new seam would otherwise inherit the same lie, and because a plan step's name is the single field that answers "what is being worked on" in words. `artifactCount` and `summary` stay unpopulated — the parent does not hold them, and inventing them here would be worse than their honest absence.

**D6 — Synthetic messages become public primitives; no new store method.** `createThreadHistory` and `appendTurn` are already exported and already used by the embedder, so appending `[syntheticUserMessage(text)]` is reachable the moment the constructor is public. Exporting `syntheticUserMessage` + `isSyntheticUserMessage` is therefore the whole of the API change; the harness keeps ownership of the wire format and the marker key, and the host supplies only its own text. Rejected: a typed `appendRunNotice(threadId, outcome)` method, which would put run vocabulary inside the conversation store and violate the store's deliberate two-method surface. Also rejected: letting the host hand-roll the `providerOptions` marker, which would fork the constant that `isGenuineUserStart` and `GENUINE_USER_START_SQL` are built from.

**D7 — A synthetic notice folds into the preceding turn, and that is accepted.** `retractLastTurn` cuts at the last genuine-user-start `seq` onward, and a synthetic message opens no turn — so a notice appended after the last exchange is removed along with that exchange if the user retracts it. The alternative, making the notice a genuine turn boundary, is strictly worse: it would split one turn into two for the token window and give retraction a mid-turn cut point, which is precisely the failure the synthetic marker exists to prevent. The exposure is narrow (only a notice landing inside the turn being retracted) and the semantics are defensible — retraction means undoing that exchange, and a run announced within it goes with it.

**D8 — Cancellation is extracted rather than carried here.** It was scoped into this change as a third seam and pulled back out, because it is a run-lifecycle decision wearing an API-surface costume. `collectAndComplete` is a plain sequential await, not a `finally`, and the body re-propagates `DBOSWorkflowCancelledError` unchanged (`execute-analysis.ts:711-718`), so cancelling the workflow leaves the run row `running` and skips the charge close and the authorization revoke. Making cancellation terminal means choosing between settling the ledger from outside the workflow — which contradicts the `workflow-failure-lifecycle` requirement that there be no separate finalisation hook — and making cancellation cooperative so the body finalises itself, which is a larger change to the scheduler and cannot interrupt a step already blocked in a long sandbox exec. Neither belongs inside a change whose entire purpose is to *observe* runs without altering them. Tracked as issue #250, and this change touches no cancellation path.

## Risks / Trade-offs

- [A host callback that is slow, not just throwing, stalls the workflow body — the guard catches throws, not latency] → The contract states the callback must return promptly and must not await I/O; the guard is synchronous-by-signature (`void`, not `Promise<void>`), which makes a slow implementation a visible design error rather than an accidental one.
- [Snapshot emission on every transition is more host work than a terminal-only signal] → Bounded by the number of steps in a plan, and the payload is built already for `emitDagSnapshot`. A host that only cares about terminal transitions can filter on run status and ignore the rest.
- [Recovery re-fires the whole snapshot sequence, so a host that appends a thread notice per terminal snapshot would append duplicates] → The idempotency D1 buys is for *display* state, not for side effects. The seam's contract names this explicitly: a host taking a durable action on a snapshot must key it by `runId` and the terminal status, exactly as `agent_switch`'s work gauge already does with the provenance events.
- [Public synthetic messages let an embedder inject arbitrary text into a thread the model reads] → That is the point, and it is already true of `appendTurn`. The marker's guarantees are structural (turn boundaries, retraction, token window) and hold regardless of content.
- [Correcting `DagStepState.name` changes an existing wire payload] → It is a strict improvement toward what the contract already documents, and the OSS CLI is the only consumer today — and it does not read the stream at all. A managed consumer rendering `name` gets a better label, never a missing one. The residual exposure is a consumer using `name` as a lookup or render *key*: `id` is the identifier and remains unchanged, so such a consumer is misusing the field, but its keys would shift.

## Migration Plan

Purely additive. Every seam is optional (`observeRun`), a new export (the synthetic primitives), or a value correction within an existing field (`DagStepState.name`). No schema change, no data migration, no behavior change for an embedder that adopts none of it. Rollback is revert.

## Open Questions

None. The scope boundaries against #247 (stream reading), #248 (autonomous agent wake-up), and #250 (cancellation) are settled.
