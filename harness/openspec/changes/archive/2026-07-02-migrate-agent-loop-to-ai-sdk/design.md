## Context

The harness currently normalizes all chat traffic into Anthropic SDK message types. That made signed Anthropic thinking blocks easy to preserve, but it also made the harness responsible for every non-Anthropic provider adapter and for every future storage migration away from Anthropic-shaped transcripts.

The AI SDK DBOS-loop spike validated the important feasibility point: the AI SDK can own the multi-step tool loop while harness wrappers preserve deterministic DBOS model-call steps, step-backed tools, workflow-backed tools, and AI SDK `ModelMessage` storage. This design now locks in the migration boundary.

Thread history needs backward compatibility because users must reopen and continue existing conversations. Existing DBOS workflow caches do not need backward compatibility because workflows must not be replayed across this migration. Completed analysis outputs are not model-message history: they are Cortex-native ledgers, files, artifacts, vector entries, and typed run streams.

## Goals / Non-Goals

**Goals:**

- Use AI SDK model/provider abstractions so the harness can support Anthropic, OpenAI-compatible, and self-hosted endpoints through a common provider runtime.
- Store conversation history as AI SDK model messages wrapped in a harness-owned operational envelope.
- Backfill existing Anthropic-shaped conversation history at startup, then run only the new storage path.
- Keep DBOS semantics for workflow loops: deterministic model-call step names, durable tool execution, typed emits, cancellation behavior, and replay-stable output.
- Preserve obligatory tool calling for bioinformatics work; no text-only provider fallback is acceptable for agents that require tools.
- Preserve completed analysis output contracts without migrating synthesis, summaries, artifacts, reports, or run streams into AI SDK message format.

**Non-Goals:**

- Migrating or replaying existing DBOS operation outputs/workflow caches.
- Keeping a long-term mixed runtime that can continue serving old Anthropic rows without startup migration.
- Replacing Cortex-native UI/run-event contracts with AI SDK UI messages as part of this change.
- Solving every provider's advanced feature parity. Unsupported provider features may be absent as long as required tool calling and loop semantics are enforced.

## Decisions

### Store AI SDK `ModelMessage` in a Harness Envelope

Conversation rows will store an envelope around the AI SDK model message:

```ts
type StoredMessageEnvelope = {
  kind: "ai-sdk-model-message";
  aiSdkMajor: number;
  message: ModelMessage;
};
```

The harness owns the envelope because it needs operational versioning and validation. The harness does not own the inner message schema beyond accepting the AI SDK major version it was written against.

Alternative considered: define a new Cortex semantic message format. Rejected because that repeats the current problem: the harness would own provider-message migration burden instead of letting AI SDK carry most of it.

### Backfill at Startup, No Old Runtime Handler

Startup state initialization will run an idempotent migration that converts old `role + content_jsonb` Anthropic rows into the AI SDK envelope. Runtime `appendTurn`, `loadRecent`, `loadPage`, and display conversion will read only the new envelope path. If startup finds an unmigrated or unconvertible row after backfill, startup fails loudly.

The migration module and its tests may contain old Anthropic conversion code. Request/runtime paths may not. The startup backfill code must include a comment noting that old Anthropic columns should be removed after the migration window.

Alternative considered: keep a dual reader indefinitely. Rejected because it preserves the old format as a live contract and complicates every future message operation.

### Use AI SDK at the Model-Call Boundary With Harness Durability Wrappers

The harness keeps ownership of loop iteration (the smallest boundary that preserves deterministic model calls, truncation handling, and terminal-tool salvage — per Risks below) and integrates AI SDK per model call: AI SDK `ModelMessage` transcripts, AI SDK tool definitions, and AI SDK provider execution. Harness code wraps:

- each model call in `runStep` with deterministic names;
- simple tools with a step-backed wrapper;
- multi-operation/body-only tools with workflow-backed dispatch in the workflow body;
- pure local tools inline only when they have no durability or external side effects.

The loop must still return a transcript and finish signal equivalent to current callers' needs. `runToTerminal` remains as a harness wrapper around terminal-tool workflows such as planning, profile submission, synthesis submission, and report submission.

Alternative considered: keep the hand-rolled Anthropic loop and only swap providers. Rejected because it keeps the harness responsible for multi-provider message/tool semantics.

### Replace `bodyContext` With Tool Execution Modes

`bodyContext` encoded an implementation workaround: some tools could not run inside `DBOS.runStep` because they call body-only APIs such as `DBOS.recv`/`writeStream`. The new tool metadata should say what the tool needs, not how the old loop should partition it:

- `step`: external/read tools wrapped as one durable step;
- `workflow`: multi-operation or body-only tools implemented as child workflows or workflow-aware durable units;
- `inline`: pure deterministic tools with no external side effects.

Sandbox mutate tools such as `execute_command`, `write_file`, and `edit_file` should become workflow-backed rather than old-loop body exceptions.

### Keep Analysis Outputs Outside AI SDK Message Storage

The model transcript is internal execution state. Analysis results remain the existing Cortex-native outputs:

- `cortex_runs` and `cortex_step_executions` ledger rows;
- typed DBOS run stream parts;
- `cortex_artifacts`;
- files under the run directory such as step `output/summary.md` and run `synthesis.json`;
- vector-index entries for summaries, synthesis, and artifact descriptions;
- working memory rows when conversation tools update them.

Completed analysis executions do not need message-format migration. Active workflows must be drained or cancelled before rollout because DBOS operation outputs are intentionally not compatible across this change.

### Dynamic Provider Configuration Belongs at the Embedder Boundary

The harness should accept an AI SDK-compatible language model provider supplied by the embedder or created from embedder-supplied endpoint/key/model policy. The CLI may discover and enforce allowed provider/model combinations before constructing the harness runtime. The harness still enforces that an agent requiring tools is only run with a model/provider configuration that advertises mature tool-call support.

## Risks / Trade-offs

- Provider-specific metadata may not round-trip through every provider adapter -> preserve signed Anthropic thinking/cache metadata in AI SDK provider metadata where supported, and add tests around Anthropic signed-cache continuation.
- AI SDK loop behavior may not expose a hook for every current harness finish semantic -> wrap AI SDK at the smallest boundary that preserves deterministic model calls, tool results, truncation handling, and terminal-tool salvage; keep harness-owned wrappers for behavior AI SDK does not own.
- Startup backfill may hit malformed legacy rows -> run in a transaction/advisory startup lock, fail startup with row identity on unconvertible data, and keep old columns temporarily for inspection.
- Workflow-backed tools may change scheduling behavior -> test step-backed, workflow-backed, mixed tool calls, cancellation, and replay behavior with scripted models before replacing the production loop.
- Dynamic provider support can make capability errors appear late -> require provider/model capability checks at runtime assembly and before each agent run that requires tools.

## Migration Plan

1. Add AI SDK dependencies and provider construction abstractions.
2. Introduce `StoredMessageEnvelope` validation, writer, and reader types.
3. Add database migration fields for the new envelope and startup backfill from old Anthropic columns.
4. Implement the startup backfill under the state initialization lock. Include a code comment that old Anthropic message columns should be removed after the migration window.
5. Convert `ThreadHistory` runtime methods to read/write only the new envelope.
6. Implement AI SDK provider/runtime wrappers and capability checks.
7. Implement AI SDK loop integration with deterministic DBOS model-call wrappers and tool execution modes.
8. Convert current tools from `bodyContext` to `step`, `workflow`, or `inline`.
9. Convert `runToTerminal`, planning, file metadata, step summary, synthesis, reports, sub-agents, and conversation chat turn call sites.
10. Validate with unit tests, the AI SDK DBOS-loop prototype expectations, and representative workflow tests.
11. Deploy only after active DBOS workflows are drained or cancelled.

Rollback is database-sensitive. Because runtime stops reading old Anthropic columns after migration, rollback to the old binary is only supported while old columns are retained and before new conversations are written exclusively in the AI SDK envelope, unless a reverse migration is added.

## Open Questions

- Whether to keep `CortexMessage` as the UI/domain display format or replace it with AI SDK UI messages is intentionally left to a later decision. This change only requires AI SDK `ModelMessage` storage.
- Exact AI SDK major version is implementation-time dependent; the envelope must record it and validation must reject unsupported majors.
