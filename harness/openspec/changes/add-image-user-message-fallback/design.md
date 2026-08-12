# Design: add-image-user-message-fallback

## Context

The loop encodes a tool picture as an image block inside the tool result, gated on `imageToolResults` (`src/loop/run-agent.ts:161,673`). A wire without the capability drops the picture with a warn (`run-agent.ts:679`). The upstream relocation for the compatible package (`vercel/ai#12621`) does the same move inside the package, and it sits unmerged. The harness cannot wait on it, and the fallback is host-agnostic loop work in any case.

## Goals / Non-Goals

**Goals:**

- A capability-gated fallback: the picture rides a user message when the tool-result wire cannot carry it.
- One user message per round, after the tool message, with each dropped picture of the round.
- The drop-with-warn path stays for a wire with neither capability.

**Non-Goals:**

- No CLI change. The embedder declares the flag per arm at its composition root.
- No change to the `imageToolResults` path of the anthropic and openai arms.
- No removal of the picture from the tool-result JSON text — the JSON never held the bytes.

## Decisions

### D1: The flag is a provider capability, not a config sniff

`ProviderCapabilities` gains `imageUserMessages?: boolean` beside `imageToolResults` (`src/providers/types.ts:19`). Absent means "cannot carry", never "unknown", the same contract as the picture flag. The embedder states the fact about its endpoint, because the harness cannot know what a proxy fronts. `createAiSdkProvider` copies the flag explicitly, the same pattern as the existing copy (`src/providers/ai-sdk.ts:519`).

### D2: The precedence is tool result, then user message, then drop

`imageToolResults` wins when set, because the tool result is the native place and it keeps the correlation implicit. The fallback engages only when `imageToolResults` is absent and `imageUserMessages` is set. When both are absent, the loop drops the picture and warns, as today.

### D3: One batched user message per round, after the tool message

The chat-completions wire requires each tool message directly after the assistant message with the tool calls. Thus the fallback message lands after `messages.push({ role: "tool", ... })` (`run-agent.ts:392,414`), and one message batches every dropped picture of the round. The upstream proposal batches the same way, for the same ordering reason. The transcript stays append-only, thus the loop invariant holds.

### D4: The encoding surfaces the dropped pictures to the round

`successResult` decides per tool result, deep under `dispatchTools`. The fallback needs the pictures at the round assembly. `ResultEncoding` grows a per-round collector: in fallback mode, `successResult` keeps the JSON-only result and records `{ toolCallId, toolName, image }`. The round assembly reads the collector, builds the user message, and clears it. The collector is per `runAgent` call, thus concurrent loops do not share it.

### D5: The message shape names its tool call

The fallback message is one `user` message: for each picture, a text part `The picture of the tool result <toolCallId> of <toolName>.`, then a file part with the media type and the base64 bytes. The text part carries the correlation, because the wire holds no structural link between a user message and a tool call. A file part is the current AI SDK form for a user image.

The message carries the synthetic marker of the harness namespace. A user message opens a conversation turn, thus an unmarked one splits a stored turn for every boundary reader. The marker builder sits beside `syntheticUserMessage` (`src/memory/ai-sdk-message-storage.ts:103`), and it gains a parts-accepting form, because a hand-rolled marker forks the shared keys in silence. The message is loop machinery, thus the display reconstruction does not render it.

### D6: History and cache are unaffected in shape

The fallback message is a plain `LoopMessage`, thus it persists in thread history and replays like any turn content. The append changes no earlier bytes, thus the prompt-cache prefix holds still.

## Risks / Trade-offs

- [A vision-less model receives an image part and errors] → the flag is opt-in per arm, absent by default. The embedder that sets it owns the claim.
- [The picture doubles if an embedder sets both flags] → the precedence in D2 makes the tool-result path exclusive, and a test pins it.
- [Token cost: a base64 image in a user message rides every later request of the thread] → the same cost exists on the tool-result path. The eyes tool already bounds its screenshot size.

## Open Questions

None.
