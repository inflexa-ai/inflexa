# Tasks: Token Usage Tracking

## 1. Provider surface

- [x] 1.1 Add `reasoningTokens` to `ChatUsage` and `requestedModelId`/`servedModelId` to `ChatResponse` in `src/providers/types.ts`, with absent-means-not-reported JSDoc
- [x] 1.2 Map the AI SDK usage's reasoning field in `toChatUsage` and stamp both model ids (bound `LanguageModel.modelId`, response `modelId`) in `src/providers/ai-sdk.ts` — non-streaming and streaming paths
- [x] 1.3 Unit tests: reasoning passthrough (reported vs absent), served-vs-requested model capture, no-model-id endpoint leaves `servedModelId` absent

## 2. UsageRecorder seam

- [x] 2.1 Create `src/billing/usage-recorder.ts`: `LlmUsageRecord` type (recordKey, agentId, callPath, scope, runId?/stepId?, model ids, usage), `UsageRecorder` interface (`record(record): void`, non-throwing contract in JSDoc), `createNoopUsageRecorder()`
- [x] 2.2 Export the seam + no-op from `src/index.ts`; add the optional `usageRecorder` parameter to `assembleCoreRuntime` defaulting to the no-op
- [x] 2.3 Thread the recorder through the deps bags to every `runAgent` invocation site: conversation agent, sub-agent tool factories (literature-reviewer, analogical-reasoner), workflow step bodies

## 3. Loop recording and finish rollup

- [x] 3.1 Deliver one record per LLM call at call completion in `src/loop/run-agent.ts` (wrap-up and aborted-with-usage included), composing `recordKey` from `runId` + `stepId` (when present) + the deterministic step name under a `RunFrame`, else a minted UUID
- [x] 3.2 Extend the `AgentRunUsage` fold (`src/loop/metrics.ts`) with `reasoningTokens`; leave the OTel counters unchanged
- [x] 3.3 Add the optional own-usage rollup and root-only turn total to `FinishEvent` in `src/contracts/chat-events.ts`; thread a turn-scoped accumulator through a new optional `ToolContext` field so sub-agent-running tools hand it to the child `runAgent`; emit both figures from the loop (absent when nothing reported)
- [x] 3.4 Tests: per-call record count incl. wrap-up; records already delivered when a later call fails fatally; aborted call with reported usage recorded; sub-agent records carry the child agentId/callPath; root finish turn total includes sub-agent usage; identical recordKey across a replayed body (deterministic step names); cross-step key distinctness; finish rollup present/absent semantics

## 4. Run-event parts

- [x] 4.1 Add the `step-usage` part (stepId, usage rollup, model identity) to `src/contracts/chat-parts.ts` and the part registry; add optional aggregate usage to `RunCompletedPart`
- [x] 4.2 Emit `step-usage` once at step-loop completion in the `executeAnalysis` child workflow (analysis runs only, per the scoped requirement); populate the run aggregate on completion
- [x] 4.3 Tests: part appears on the stream at step completion; replayed emission folds latest-wins to a single part per step id

## 5. Verification

- [x] 5.1 `tsc -p tsconfig.json` clean; `bun test` green (DB/DBOS suites per testing notes)
- [x] 5.2 `bun run format:file` on every changed `src/` file
- [x] 5.3 `openspec validate token-usage-tracking` passes; re-read the delta specs against the implementation for drift
