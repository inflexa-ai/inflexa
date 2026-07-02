## Why

The harness currently treats Anthropic message shape as its provider lingua franca, which makes every additional model provider depend on harness-owned adapters and forces us to own migration semantics for model transcripts. Moving the loop and stored model transcript to Vercel AI SDK gives the harness a mature provider abstraction while keeping DBOS durability, tool calling, and completed analysis outputs under harness control.

## What Changes

- **BREAKING**: Replace the Anthropic-native `ChatProvider` request/response contract with an AI SDK language-model based provider contract.
- **BREAKING**: Store conversation thread history as AI SDK `ModelMessage` payloads wrapped in a small harness envelope, instead of storing Anthropic `ContentBlockParam[]` directly.
- Add an idempotent startup backfill that migrates existing `messages` rows from Anthropic-shaped content to the AI SDK envelope before runtime starts serving history.
- Remove long-term runtime support for the old Anthropic message handler after backfill; old-format conversion is allowed only in the startup migration module and tests.
- Use the AI SDK tool loop for agent execution where it can preserve required behavior: deterministic DBOS model-call steps, durable tool execution, required tool calling, max-iteration handling, truncation safety, and typed orchestration emits.
- Replace the `bodyContext` loop exception with explicit tool execution modes: step-backed tools, workflow-backed tools, and inline pure tools.
- Preserve analysis execution output contracts: run/step ledgers, typed run streams, artifact manifests, step summaries, synthesis JSON, vector entries, and report files remain Cortex-native outputs and are not migrated to AI SDK message format.
- Treat existing DBOS workflow caches as non-compatible internal execution state; deployments must drain or cancel active workflows before enabling this migration.
- Support dynamic provider configuration by allowing embedders to provide model endpoints, API keys, and allowed-model policy while the harness consumes AI SDK-compatible providers.

## Capabilities

### New Capabilities

- `ai-sdk-message-storage`: Defines the AI SDK model-message envelope stored for thread history and the startup backfill from old Anthropic rows.
- `ai-sdk-provider-runtime`: Defines the AI SDK provider runtime, dynamic provider configuration, and provider metadata preservation expectations.

### Modified Capabilities

- `harness-providers`: Replaces Anthropic-native provider lingua franca requirements with AI SDK language-model provider requirements while preserving session-scoped attribution and error classification.
- `harness-agent-loop`: Replaces the hand-rolled Anthropic tool loop contract with an AI SDK loop integration that preserves DBOS step semantics, tool calling, truncation safety, and terminal behavior.
- `harness-tools`: Replaces `bodyContext` with explicit tool execution modes that allow step-backed and workflow-backed durable tool wrappers.
- `harness-thread-history`: Changes the durable thread-history row content from Anthropic blocks to AI SDK model-message envelopes, with one-time startup backfill for existing rows.
- `harness-thread-store`: Clarifies that workflow and sandbox agent loop transcripts remain internal DBOS execution state and are not migrated, while completed analysis outputs remain Cortex-native artifacts/results.

## Impact

- Affected code: `src/providers/*`, `src/loop/*`, `src/tools/define-tool.ts`, tool registry/wrappers, `src/memory/thread-history.ts`, `src/memory/content-to-cortex.ts`, startup state initialization, workflow loop call sites, and provider composition in `src/runtime/assemble.ts`.
- New dependency surface: Vercel AI SDK core packages and provider packages/adapters selected by the embedder.
- Database impact: startup migration/backfill for `messages`; old Anthropic columns may remain temporarily for rollback/inspection but runtime reads only the new AI SDK envelope after migration. The migration code must include a comment noting that old columns should be removed after the migration window.
- Operational impact: active DBOS workflows must be drained or cancelled before rollout; existing DBOS operation outputs are not migrated or replay-compatible.
- Consumer/API impact: analysis outputs, typed run-event streams, artifact ledgers, synthesis JSON, and summaries stay in their current Cortex-native contracts.
