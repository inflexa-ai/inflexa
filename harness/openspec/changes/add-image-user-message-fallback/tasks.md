# Tasks: add-image-user-message-fallback

## 1. The capability

- [x] 1.1 Add `imageUserMessages?: boolean` to `ProviderCapabilities` in `src/providers/types.ts`, with a JSDoc in the shape of the `imageToolResults` block.
- [x] 1.2 Copy the flag in `createAiSdkProvider` (`src/providers/ai-sdk.ts`), the same conditional spread as the existing copy.

## 2. The loop fallback

- [x] 2.1 Grow `ResultEncoding` in `src/loop/run-agent.ts`: the mode from the two flags, and a per-round collector for the dropped pictures.
- [x] 2.2 In `successResult`, on the fallback mode: keep the JSON-only result, and record `{ toolCallId, toolName, image }` into the collector.
- [x] 2.3 After each tool-message push, build one user message from the collector, append it, and clear the collector. The text part names the tool call, and the file part carries the picture.
- [x] 2.4 Keep the drop-with-warn path when both flags are absent.

## 3. Tests

- [x] 3.1 A fallback test: one round, one picture, the tool result keeps its JSON text, and one user message carries the picture with its tool-call name.
- [x] 3.2 A batch test: two pictures in one round give one user message, in the order of the tool calls, directly after the tool message.
- [x] 3.3 A precedence test: both flags set gives the tool-result path only, with no fallback message.
- [x] 3.4 A drop test: neither flag gives the JSON text, no picture, and a warn record.
- [x] 3.5 A capability test: the factory copies the stated flag, and an absent flag stays absent.
- [x] 3.6 A marker test: the fallback message satisfies `isSyntheticUserMessage`, thus a turn-boundary reader skips it.

## 4. Closure

- [x] 4.1 Run `bun run format:file` on the changed source files, then `tsc -p tsconfig.json`.
- [x] 4.2 Run the targeted test files of the loop and the providers only.
