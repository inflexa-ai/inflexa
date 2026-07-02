## 1. Dependencies and Provider Runtime

- [x] 1.1 Add AI SDK core/provider dependencies to `harness/package.json` and update the lockfile.
- [x] 1.2 Define the AI SDK-backed provider interfaces/types that replace Anthropic-native `ChatRequest`/`Message` in `src/providers/types.ts`.
- [x] 1.3 Implement provider construction for embedder-supplied AI SDK language models or endpoint/key/model configuration.
- [x] 1.4 Preserve session-required provider calls and billing attribution resolution at the model/embedding wire boundary.
- [x] 1.5 Map AI SDK/provider failures into the existing `ProviderError` categories and preserve abort propagation.
- [x] 1.6 Add provider capability checks that reject tool-required agents when the selected model/provider cannot perform mature tool calling.
- [x] 1.7 Add tests for dynamic provider configuration, tool-capability rejection, billing header resolution, abort propagation, and provider-error classification.

## 2. AI SDK Message Storage and Backfill

- [x] 2.1 Add `StoredMessageEnvelope` validation for `{ kind: "ai-sdk-model-message", aiSdkMajor, message }`.
- [x] 2.2 Add the new message-table storage field or table shape for AI SDK model-message envelopes.
- [x] 2.3 Implement Anthropic-to-AI-SDK conversion for legacy `messages.role` + `messages.content_jsonb` rows inside a startup migration module only.
- [x] 2.4 Preserve legacy text, tool-use/tool-result continuity, tool-call ids, tool names, tool inputs, tool results, error markers, and supported signed provider metadata during conversion.
- [x] 2.5 Run the backfill idempotently during startup state initialization under the existing startup/state lock.
- [x] 2.6 Fail startup with row identity when any legacy row cannot be converted or any unmigrated row remains.
- [x] 2.7 Add the required startup backfill code comment that legacy Anthropic message columns should be removed after the migration window.
- [x] 2.8 Convert `ThreadHistory.appendTurn`, `loadRecent`, and `loadPage` to read/write only AI SDK envelopes after startup.
- [x] 2.9 Convert `content-to-cortex` display mapping from AI SDK envelopes to `CortexMessage` without mutating stored messages.
- [x] 2.10 Add tests for backfill idempotency, unconvertible-row failure, old-format runtime absence, tool-call continuity, provider metadata preservation, and display conversion.

## 3. Tool Definitions and Execution Modes

- [x] 3.1 Replace `bodyContext` with `executionMode: "step" | "workflow" | "inline"` in `defineTool` and `Tool`.
- [x] 3.2 Emit AI SDK-compatible tool definitions from Zod schemas.
- [x] 3.3 Implement the step-backed tool wrapper with deterministic `runStep` names and the existing tool error contract.
- [x] 3.4 Implement the workflow-backed tool wrapper for multi-operation/body-only tools.
- [x] 3.5 Convert `execute_command`, `write_file`, and `edit_file` to workflow-backed tools.
- [x] 3.6 Classify all existing tools as `step`, `workflow`, or `inline`.
- [x] 3.7 Add tests for schema emission, execution-mode defaults, workflow-backed sandbox mutate tools, step-backed replay naming, inline purity expectations, and error result mapping.

## 4. AI SDK Agent Loop

- [x] 4.1 Implement the AI SDK-backed `runAgent` integration using deterministic model-call wrappers.
- [x] 4.2 Preserve append-only AI SDK `ModelMessage` transcripts and return `{ messages, finish }`.
- [x] 4.3 Preserve iteration cap behavior with one tool-less finalization call and `finish.reason = "max_iterations"`.
- [x] 4.4 Preserve output-token truncation recovery without executing incomplete trailing tool calls.
- [x] 4.5 Preserve model-visible tool errors for thrown, `err(ToolError)`, and invalid-input tool calls.
- [x] 4.6 Preserve fatal error propagation for cancellation and workflow-backed fatal errors.
- [x] 4.7 Preserve sub-agent session derivation and ephemeral sub-agent transcripts.
- [x] 4.8 Adapt `runToTerminal` for AI SDK transcripts and terminal tools.
- [x] 4.9 Add loop tests for deterministic model/tool step naming, mixed tool execution modes, tool errors, truncation recovery, iteration cap finalization, fatal propagation, and sub-agent delegation.

## 5. Call-Site Migration

- [x] 5.1 Update conversation chat turn assembly and persistence to pass AI SDK `ModelMessage` history into `runAgent`.
- [x] 5.2 Update planning (`generatePlan`) and other loop-driving tools to use the AI SDK-backed loop and terminal salvage.
- [x] 5.3 Update file metadata generation, step summary generation, synthesis generation, target assessment, report iteration, and literature sub-agent call sites.
- [x] 5.4 Keep completed analysis outputs in existing Cortex-native contracts: run/step ledgers, typed run streams, artifacts, summaries, synthesis JSON, vector entries, reports, and working memory.
- [x] 5.5 Remove Anthropic-only registry/request helpers from runtime paths after replacement.

## 6. Rollout and Verification

- [x] 6.1 Add an operational rollout note requiring active DBOS workflows to be drained or cancelled before enabling the AI SDK runtime.
- [x] 6.2 Verify the startup backfill migrates conversation thread history and does not rewrite DBOS operation outputs.
- [x] 6.3 Verify existing completed run outputs remain readable through `inspectRun`, artifact lookup, vector search, and report/synthesis readers.
- [x] 6.4 Run `bun test` in `harness`.
- [x] 6.5 Run `npm run build` or `tsc -p tsconfig.json` in `harness`.
- [x] 6.6 Remove or archive the throwaway AI SDK DBOS-loop prototype after production tests cover its validated behavior.
