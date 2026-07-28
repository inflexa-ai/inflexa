## Why

An embedder driving a live UI cannot see a run happen. The harness's only host-facing run observation is `emitProvenance` — three coarse arms (`run_started` / `step_completed` / `run_completed`) shaped for a signed provenance chain, carrying no step identity beyond `stepId`, no step-*started* edge, and no notion of the run's current shape. Everything richer is written to the DBOS `"events"` stream, which has no reader on the OSS side.

The consequence in the field is inflexa-ai/inflexa#241 and #244: the CLI polls ledger rows every five seconds, renders each step by its opaque `stepId`, and signals completion by making a widget disappear. The agent is equally blind — it launches a run, promises to check back, and has no mechanism to do so.

Two narrow seams close the gap without touching the stream: let the host **observe** run state as it changes, and let the host **record** a run's outcome into the conversation thread.

## What Changes

- **New optional `observeRun` dep on `ExecuteAnalysisDeps`** — a fire-and-forget host callback fed from the run's existing state-transition points. It carries a **snapshot**, not granular events: the run's identity plus the full per-step state at that moment. Snapshot-over-event is the load-bearing choice — DBOS body re-execution re-fires the callback on recovery, and a re-fired *snapshot* is idempotent by construction, whereas re-fired granular events force every consumer to build its own dedupe. `emitProvenance` is untouched and stays provenance-only.

- **`emitDagSnapshot` populates the plan step's real `name`.** It currently sets `name: s.id`, so the `data-dag-state` part advertises a human name and ships a slug. The value is already on the workflow input, though not where the emitter is looking: `input.steps` is the *scheduler's* narrow `{id, depends_on}` projection, while the full plan step — including its required `name` — is snapshotted on `input.planStepById`, which the dispatch path already reads. This corrects the existing stream part as well as feeding the new seam; a plan step's name is the only field that answers "what is being worked on" in words.

- **`syntheticUserMessage` / `isSyntheticUserMessage` become public.** The mechanism exists (`src/memory/ai-sdk-message-storage.ts`) and is exactly right for a run-outcome record appended between turns: it carries the `user` role for the wire format but is excluded from turn-boundary detection in both TypeScript (`isGenuineUserStart`) and SQL (`GENUINE_USER_START_SQL`), so it neither opens a turn, splits the token window, nor gives `retractLastTurn` a mid-turn cut point. No new `ThreadHistory` method is needed — `createThreadHistory` and `appendTurn` are already exported and already used by the embedder. The contract widens from "the loop synthesizes these" to "the loop or the host synthesizes these".

Out of scope, deliberately: reading the DBOS `"events"` stream (issue #247), waking the conversation agent autonomously on completion (issue #248), and host-initiated run cancellation (issue #250). This change gives the host the signal and the record; what it does with them is the embedder's business.

Cancellation was scoped into this change and then extracted, because it is not the small export it appears to be. `collectAndComplete` — the single finalisation hook — does not run on the cancellation path, so cancelling the workflow alone leaves `cortex_runs.status = 'running'` and skips the charge close and authorization revoke. Making cancellation terminal therefore means either settling the ledger from outside the workflow (weakening the single-finalisation invariant) or making cancellation cooperative so the body can finalise itself. That is a design decision about run lifecycle, not an API surface, and it does not belong inside an observation change.

## Capabilities

### New Capabilities

- `run-observation-seam`: the optional `observeRun` host callback on `ExecuteAnalysisDeps` — its snapshot payload, its emission points, its replay and isolation semantics, and its separation from `emitProvenance`.

### Modified Capabilities

- `ai-sdk-message-storage`: synthetic messages become a host-authorable concern, not a loop-internal one. The `providerOptions` marker and every turn-boundary guarantee built on it are unchanged; what changes is who may author such a message and that the primitives are public.
- `harness-durable-runtime`: `DagStepState.name` carries the plan step's name rather than its id.

`workflow-failure-lifecycle` is **not** modified here. Its single-finalisation requirement asserts that `collectAndComplete` runs on every terminal path *including external cancel*, which the body contradicts — but correcting that assertion is cancellation's business and belongs with issue #250, not with an observation change that never cancels anything.

## Impact

- **`src/workflows/execute-analysis.ts`** — the `observeRun` dep and its guarded invoker (mirroring `emitProvenanceGuarded`), fed from the eight existing `emitDagSnapshot()` call sites plus the run-start and terminal boundaries; `emitDagSnapshot` populates `name` from `PlanStep.name`.
- **`src/index.ts`** — exports for `syntheticUserMessage`, `isSyntheticUserMessage`, and the observation payload types.
- **`src/memory/thread-history.ts`** — prose only: the synthetic-message rationale widens from loop-authored to loop-or-host-authored. `isGenuineUserStart` and `GENUINE_USER_START_SQL` are unchanged.
- **Not touched**: the DBOS `"events"` stream and its parts, `prepareChatTurn` / `assembleMessages`, `emitProvenance` and `RunProvenanceEvent`, the agent loop, the sandbox protocol, and every cancellation path.
- **Consumers**: the CLI is the only embedder today; a companion change wires both seams. Every seam is optional or additive, so an embedder that ignores them behaves exactly as before.
