# Proposal

## Why

The result of `generate_analogy_report` goes only to the model, and no surface shows it. Thus the agent must copy the full report into its reply, and the reply loses the coverage state of each analogy. A host can render the report correctly only when the harness gives it the report as a typed part.

## What Changes

- `generate_analogy_report` emits a durable `data-analogy-report` part after its child workflow returns. The part carries the full result of the tool: the report, or the `extraction-failed` envelope.
- The tool still gives the same envelope to the model.
- The chat-part contract, the part registry, and the conversation display storage know the new part. Thus a reload shows the same report.
- The conversation prompt and the tool description tell the agent that the analogy block shows the report. The reply gives a short summary of the analogies that matter for the data, and it ends with one question.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `analogy-report`: the tool emits the report as a durable part, and the reply gives a summary in place of the full report.

## Impact

- `src/tools/research/generate-analogy-report.ts` and its test.
- `src/contracts/chat-parts.ts`, `src/contracts/schemas/chat-parts.ts`, `src/contracts/part-registry.ts`, `src/contracts/index.ts`, and `src/index.ts`.
- `src/memory/conversation-display-storage.ts` and its tests.
- `src/prompts/conversation.ts` and `src/agents/test/conversation-agent.test.ts`.
- A host that does not know the part sees an unknown `data-*` part. The cli change `render-analogy-report-block` adds the renderer.
