## Why

An aborted chat turn discards everything the model produced before the cut: `runAgent` exits by re-thrown `AbortError` before returning its message array, so an embedder can persist only the user message. The consequences surface immediately in any host: the next model call sees two adjacent user messages and truthfully denies the interrupted reply ever existed, a process restart makes the partial reply vanish from the transcript, and the display converter coalesces the adjacent user rows into one bubble — fabricating a message the user never sent. Interruption is now a first-class gesture in the CLI, so the abort path must preserve what was produced, the way it survives in comparable agent products.

## What Changes

- `createStreamingChat` resolves a client abort as a `ChatResponse` with finish reason `"aborted"`, carrying an assistant message assembled from the text deltas it already forwarded — instead of re-throwing the `AbortError`. The plain non-streaming `ChatProvider.chat` still throws on abort, so workflow-loop cancellation semantics are untouched (the streaming wrapper's only caller is the interactive chat path).
- `ChatResponse.finishReason` widens to `FinishReason | "aborted"`; `AgentFinish.reason` gains `"aborted"` the same way.
- `runAgent` ends an `"aborted"` reply through its existing terminal return path: the partial assistant message joins `messages` only when it carries content, and the turn's last loop-produced assistant message is stamped with a durable interruption marker.
- `ai-sdk-message-storage` gains an interruption marker key in the harness `providerOptions` namespace beside the existing synthetic-message key, with a pure mark/read helper pair.
- `contentToCortexMessages` restricts same-role coalescing to assistant runs — adjacent `user` rows stay separate messages — and maps a marked row to `interrupted: true` on the `CortexMessage` it lands in. `CortexMessage` gains the optional `interrupted` field.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `harness-providers`: the streaming entry point's abort behavior — a client abort resolves with the accumulated partial and an `"aborted"` finish reason rather than propagating the throw.
- `harness-agent-loop`: `runAgent`'s terminal contract — an aborted run returns its transcript (with the partial reply, content-permitting) and reports `finish.reason: "aborted"`; the last assistant message carries the interruption marker.
- `ai-sdk-message-storage`: a second harness marker — `interrupted` — rides the harness `providerOptions` namespace and survives the storage round-trip.
- `harness-thread-history`: the stored-message display converter — coalescing is assistant-only, and the interruption marker surfaces as a flag on the converted message.

## Impact

- `src/providers/streaming-chat.ts`, `src/providers/types.ts` — abort resolution + finish-reason widening.
- `src/loop/run-agent.ts` — aborted terminal path, empty-partial guard, marker stamping.
- `src/memory/ai-sdk-message-storage.ts` — marker key + helpers.
- `src/memory/content-to-cortex.ts`, `src/contracts/message.ts` — coalescing restriction + `interrupted` mapping.
- `src/index.ts` — export the marker helpers if the embedder-facing surface needs them (the CLI reads `interrupted` off `CortexMessage`, so likely no new barrel export).
- Consumer: the CLI turn engine branches on `finish.reason === "aborted"` and persists `[userMessage, ...partial]` — the companion CLI change `chat-interrupt-persist-flow`.
