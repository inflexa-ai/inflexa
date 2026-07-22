# Tasks — abort-preserves-partial-turn

## 1. Providers: abort resolves with the partial

- [x] 1.1 Widen `ChatResponse.finishReason` to admit `"aborted"` (`src/providers/types.ts`), documenting that only the streaming wrapper produces it.
- [x] 1.2 `createStreamingChat.chat` accumulates forwarded deltas and, on the stream's `AbortError`, resolves `ok({ message: assistant(partial), finishReason: "aborted" })` instead of re-throwing (`src/providers/streaming-chat.ts`). Non-abort throws keep mapping to `err(ProviderError)`.
- [x] 1.3 Tests: mid-stream abort yields the concatenated deltas; pre-delta abort yields an empty partial; a non-abort stream failure still returns `err`.

## 2. Storage: the interruption marker

- [x] 2.1 Add the interruption marker key beside `SYNTHETIC_MESSAGE_KEY` in the harness namespace with a pure mark/read helper pair (`src/memory/ai-sdk-message-storage.ts`).
- [x] 2.2 Tests: a marked assistant message round-trips through `appendTurn`/read-back; an unmarked message reads as not interrupted; a marked-tail turn retracts and windows identically to an unmarked one.

## 3. Loop: aborted terminal path

- [x] 3.1 `runAgent` handles a `"aborted"` reply through the terminal return: skip pushing an empty partial, stamp the marker on the last loop-produced assistant message when one exists, return `finish.reason: "aborted"`; widen `AgentFinish.reason` (`src/loop/run-agent.ts`).
- [x] 3.2 Tests covering the four delta scenarios: partial-text abort (marker on the partial), no-output abort (transcript unchanged beyond initial), mid-tool abort (complete `tool` message, marker on the tool-calling step, no dangling call), clean stop unchanged.

## 4. Converter: assistant-only coalescing + interrupted flag

- [x] 4.1 Add optional `interrupted` to `CortexMessage` (`src/contracts/message.ts`).
- [x] 4.2 Restrict coalescing to assistant runs and map a marked row to `interrupted: true` on its converted message (`src/memory/content-to-cortex.ts`).
- [x] 4.3 Tests: adjacent user rows yield two messages; a marked assistant run yields one message with `interrupted: true`; unmarked messages omit the field; existing tool-step coalescing unchanged.

## 5. Gates

- [x] 5.1 `tsc -p tsconfig.json` clean; `bun test` green (schema-scoped Postgres where needed).
- [x] 5.2 `bun run format:file` on every touched `src/` file.
