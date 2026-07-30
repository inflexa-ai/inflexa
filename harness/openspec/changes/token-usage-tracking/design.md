# Design: Token Usage Tracking

## Context

Every LLM call already returns a `ChatUsage` (input/output/cache-read/cache-write tokens, `providers/ai-sdk.ts:toChatUsage`), and `runAgent` already folds it per run (`loop/metrics.ts:addChatUsage`). But the fold's only consumer is `recordAgentRun`, which flattens attribution to `agent_id` and writes OTel counters — invisible to a local OSS user, and unusable for "which request/run/step/model spent the tokens" (inflexa#243). Meanwhile the provider call site holds a full `AgentSession` (`Provenance`, `Scope`, optional `RunFrame`) and the AI SDK response carries the id of the model that actually answered — both currently discarded.

Constraints that shape the design:

- **Host-agnostic**: the harness may not name a storage or display technology. Persistence and UI belong to the embedder (root `CLAUDE.md` boundary rule), so the harness exposes a seam and events, not a database.
- **DBOS replay**: inside workflows, LLM calls are durable steps — on replay the cached `ChatResponse` is returned without a wire call, but the surrounding body re-executes. Anything that records usage from the body re-fires on replay.
- **Absent ≠ zero**: `ChatUsage` semantics (a provider that reports nothing contributes nothing) must survive end-to-end.

## Goals / Non-Goals

**Goals:**

- Per-call usage records with full attribution (agent, call path, scope, run/step, requested + served model), delivered through a harness-owned seam an embedder can realize.
- Live usage on the existing event surfaces: chat `FinishEvent` (turn rollup) and the run-event stream (per-step).
- Exactly-once accounting under DBOS replay.
- `reasoningTokens` and served-model identity captured at the provider mapping site.

**Non-Goals:**

- Cost/pricing computation (no pricing dependency; token counts only).
- Task-adaptive model routing (per-agent model roles already exist in the embedder config; adaptivity is a separate change).
- The CLI realization (SQLite table, TUI display, report command) — companion change in `cli/`.
- Changing the existing OTel counters — they stay as-is.
- Gateway-side accounting (CLIProxyAPI) — only covers one connection mode and cannot attribute per-run.
- Usage event parts for non-analysis workflows (target assessment, ephemeral runs, data profiling) — their calls reach the ledger through the seam; parts are scoped to analysis runs.

## Decisions

### D1: Capture in the loop, not the provider

`runAgent` is the single site that sees every reply in both execution modes (HTTP chat and DBOS workflow), already folds usage per call, and holds the session. Recording there means one code path, no per-provider wiring, and sub-agent runs (which are just tools calling `runAgent`) are covered by the same mechanism. The provider's job is only to make the inputs available on `ChatResponse`.

*Alternative considered*: record inside `providers/ai-sdk.ts`. Rejected — providers are constructed per-model at the embedder's composition root, so the recorder would have to thread through embedder-built provider factories, and the provider lacks loop context (iteration index, deterministic step name) needed for the idempotency key.

### D2: `ChatResponse` carries both model identities

The provider stamps `requestedModelId` (from the bound `LanguageModel.modelId`) and `servedModelId` (from the AI SDK response's `response.modelId`, when reported) onto `ChatResponse`. This is what makes the aliasing question ("is the model that answered the one I configured?") answerable — and it keeps the loop-side recorder complete without new plumbing. Both optional; absent means not reported.

### D3: A `UsageRecorder` capability seam, fire-and-forget

New seam in `billing/usage-recorder.ts` (sibling of `ResolveBilling`/`RunCharge`, which it complements: `RunCharge` brackets a run for managed billing; `UsageRecorder` streams fine-grained telemetry):

```ts
interface UsageRecorder {
    record(record: LlmUsageRecord): void;
}
```

- **Fire-and-forget, non-throwing.** A recorder failure must never fail a run: realizations own their error handling; the harness contract is that `record` does not throw and the loop does not await it. Diagnostics go through the injected `Logger`.
- OSS default `createNoopUsageRecorder()`, exported from `index.ts`, wired as an optional parameter of `assembleCoreRuntime` and threaded through the existing deps bags (conversation agent, sub-agent tool factories, workflow step bodies) — the same pattern every other seam uses.

*Alternative considered*: reuse `RunCharge`. Rejected — `RunCharge` is a run-level open/close bracket with settlement semantics; usage records are per-call, exist outside runs (chat turns), and carry no monetary meaning.

### D4: Record shape

```ts
interface LlmUsageRecord {
    /** Idempotency key — consumers MUST upsert on it (see D5). */
    readonly recordKey: string;
    readonly agentId: string;
    readonly callPath: readonly string[];
    /** Scope ids as attribution columns: analysisId or targetAssessmentId. */
    readonly scope: Scope;
    readonly runId?: string;
    readonly stepId?: string;
    readonly requestedModelId?: string;
    readonly servedModelId?: string;
    readonly usage: ChatUsage;
}
```

No timestamp field: the harness cannot stamp wall-clock time deterministically inside a replayable body; the sink stamps receipt time (last-write-wins under the upsert is acceptable). A chat-path-only timestamp was considered and rejected — it would hand consumers two time semantics for one record type; one uniform rule keeps the contract simple, and token counts, not times, are the payload.

### D5: Replay safety by deterministic key + sink upsert

The loop already names its durable steps deterministically (harness-agent-loop requirement "Step names are deterministic"). The record key reuses that scheme: with a `RunFrame`, `recordKey = "{runId}:{stepId}:{deterministic step name of the LLM call}"` (the `stepId` segment present exactly when the frame carries one) — identical on every replay of the same call, so a sink that upserts on the key counts each call exactly once. The `stepId` segment is load-bearing: step names are unique only *within one DBOS workflow* (that is all durability needs), and `executeAnalysis` runs one child workflow per step under one shared `runId` — without the discriminator, step A's `llm-0` and step B's `llm-0` would collide and an upserting sink would under-count every multi-step run. Sibling workflows under one `runId` are distinguished by `stepId`; the workflow with no `stepId` (the parent) collides with nothing because its keys carry one fewer segment. Without a `RunFrame` (HTTP chat path — no replay possible), the key is a freshly minted UUID. Dedup responsibility sits at the sink (`INSERT ... ON CONFLICT ... DO UPDATE` or equivalent); the harness guarantees key stability, not delivery-once.

*Alternative considered*: record only inside `runStep` bodies so the DBOS step cache suppresses re-recording. Rejected — it would silently skip recording on every replayed step *and* leave the chat path uncovered; it also couples accounting to durability internals.

*Alternative considered*: an explicit `{runId}:{stepId}:{iteration}` counter key. Rejected for its `{iteration}` component — a hand-kept counter would be a second uniqueness scheme running beside the step-name scheme the loop already guarantees deterministic (and that DBOS durability itself depends on); two schemes can drift, one cannot. The `{stepId}` component is not what was wrong with it, and the shipped key keeps it.

### D6: Usage on existing event surfaces, additive

- **Chat path**: every loop's `FinishEvent` gains optional `usage` — that loop's own folded rollup, source-tagged like every chat event (sub-agent loops already emit into the same stream via `ctx.emit`). The **root** loop's finish additionally carries `turnUsage` — the whole turn's total, descendant loops included. Mechanism: the loop folds each call into its own rollup *and* into a turn-scoped accumulator; the root creates the accumulator, and it reaches child `runAgent` invocations through a new optional `ToolContext` field that sub-agent-running tools pass down. Whichever loop created the accumulator is by construction the root — that is what licenses stamping `turnUsage` on its finish alone. Both figures absent when nothing was reported.
- **Abort and error semantics**: records fire at call completion, never at run completion — a turn that later dies fatally has already delivered its completed calls to the seam. An aborted reply that reported usage is folded and recorded like any other (the loop's fold precedes its abort branch); a call that reported nothing produces no record. An error-terminated turn emits `ChatErrorEvent`, which stays usage-free: the seam ledger is the complete account; finish rollups exist only on turns that finish.
- **Workflow path**: a new run-event part `step-usage` (`{stepId, usage}` + model identity), emitted once when an analysis-run step's sandbox-agent loop completes; `RunCompletedPart` gains optional aggregate usage for the run. Deliberately scoped to analysis runs — the workflows without step parts (target assessment, ephemeral runs, data profiling) reach the ledger through the seam like every `runAgent`, and gain event surfaces only if a host demands them. Both parts ride the existing single run-event stream — no new transport, and replay/latest-wins folding by part id applies as for every other part.

### D7: `reasoningTokens` joins `ChatUsage`

Mapped in the one existing translation site (`toChatUsage`) from the AI SDK usage's reasoning field. Recorded only when reported — no derivation (whether reasoning tokens are a subset of output tokens varies by provider; the harness records what the provider said, nothing more).

## Risks / Trade-offs

- [Replayed workflow bodies re-fire `record`] → deterministic `recordKey` + documented sink-upsert contract (D5); the spec makes upsert a MUST for consumers.
- [Recorder realization blocks or throws in the hot loop] → contract: `record` is synchronous-signature, fire-and-forget, must not throw; realizations buffer/flush internally; harness never awaits it.
- [The turn accumulator adds a `ToolContext` field] → additive and optional; tools that never run sub-agents ignore it, and `defineTool`'s contract is unchanged.
- [AI SDK usage-field churn across majors (`inputTokenDetails`, reasoning field location)] → all mapping confined to `toChatUsage` + the response-model capture site; covered by provider unit tests.
- [Served model id not reported by some endpoints/proxies] → field stays absent; consumers must treat requested-vs-served comparison as best-effort diagnostics, not an invariant.

## Migration Plan

Purely additive: new optional fields on `ChatUsage`/`ChatResponse`/`FinishEvent`, a new part type, a new optional seam parameter defaulting to no-op. No data migration, no breaking exports. Rollback = stop wiring the seam; events degrade to absent fields existing consumers already tolerate.

## Open Questions

None blocking. Part-level field details (whether `step-usage` also carries per-call breakdown vs the step rollup only) are pinned in the spec: step rollup only — per-call granularity is the seam's job.
