# Design — abort preserves the partial turn

## D1. The abort resolves at the streaming wrapper, not in the loop

The place a client abort stops being control flow is `createStreamingChat.chat` (`src/providers/streaming-chat.ts`). It already sees every text delta (it forwards each to `onText`), so it is the only layer that can assemble the partial without new plumbing: it accumulates the deltas it forwards and, on catching the `AbortError` the underlying `chatStream` throws, resolves `ok({ message: assistant(partialText), finishReason: "aborted" })` instead of re-throwing.

Why here and not a catch inside `runAgent`:

- **Workflow cancellation must keep throwing.** Sub-agent and workflow loops run on the plain `ChatProvider`, whose `chat` still re-throws aborts; DBOS records a step failure only on a throw, and the sandbox/workflow drivers rely on cancellation propagating out of the loop. Changing only the streaming wrapper — whose sole caller is the interactive chat path — leaves every durable path byte-identical.
- **The loop needs no new state.** With the wrapper resolving, `runAgent`'s existing `finishReason !== "tool-calls"` terminal branch (`run-agent.ts:177`) already returns `{ messages, finish }`; the aborted reply flows through the same exit as a clean stop, emitting the same terminal iteration event and recording run metrics (usage on an aborted reply is whatever the provider reported, usually nothing).

An abort that fires before the first delta (including the abort-with-signal-already-aborted case: the next `chatStream` call throws immediately) resolves the same way with an empty partial — so aborts at every point of the turn surface uniformly as an `"aborted"` finish.

## D2. The partial is text-only, and that is sufficient for validity

`chatStream` yields text deltas and one terminal collapsed response; tool calls exist only in the terminal event. So at the wrapper there is no such thing as a partial tool call — an aborted stream can only ever contribute partial *text*, and nothing invalid (a dangling `tool-call` without its `tool-result`) can enter the transcript from this path.

The mid-tool abort needs no synthetic closure either, because the chat path wires no `isFatalLoopError`: a tool that honors `ctx.signal` throws, `execute`'s catch converts it to an error tool result, the loop pushes the complete `tool` message, and the *next* LLM call resolves `"aborted"` with an empty partial. The persisted sequence — `user, assistant(tool_use), tool(error results)` — is valid by construction. No message is ever truncated mid-pair.

## D3. Empty partials contribute no message

An aborted reply whose partial carries no content is not pushed onto `messages`. This keeps two embedder behaviors exactly as they are today:

- a no-output abort persists `[userMessage]` alone — the retract window ("turn produced nothing") stays detectable by the same rule;
- no empty assistant bubble can be persisted, mirroring the live UI's drop-the-empty-shell rendering.

## D4. The interruption marker rides `providerOptions.cortex` on the assistant row

The harness already owns a namespace for facts that must travel from the loop, through `appendTurn`, into a stored row and back: `providerOptions[HARNESS_PROVIDER_NAMESPACE]` (`ai-sdk-message-storage.ts` — the synthetic-message marker's documented rationale: `ModelMessage` offers no other field that survives the round trip). The interruption marker is a second key in the same namespace, stamped by the loop on the last loop-produced assistant message when the finish is `"aborted"` (the streamed partial when there is one; the last tool-calling step when the abort landed during dispatch; nothing when the turn produced nothing).

Alternative rejected — a synthetic marked *user* message ("[reply interrupted]") appended to the turn: it would make the interruption model-visible, but it fabricates dialogue the user never sent, costs tokens on every future turn, and the badge only needs a read-side flag. The abrupt ending of the partial text is itself the model-visible signal; experience with comparable products shows models handle a cut-off assistant message followed by "continue" without an explicit marker. If field use proves otherwise, a marked synthetic message can be layered on later without disturbing this marker.

Because the marker rides an **assistant** message, every turn-boundary reader (`isGenuineUserStart`, the tail-retract SQL predicate, `loadRecent` snapping) is untouched by construction.

## D5. Coalescing becomes assistant-only

`contentToCortexMessages` merges consecutive same-role rows to restore the one-bubble-per-turn shape over the loop's per-step assistant rows (its own doc states this purpose). User rows never legitimately split into runs — adjacent `user` rows arise only from turns that produced no persisted reply — so merging them invents a message. The rule becomes: coalesce only when the (mapped) role is `assistant`. A marked row anywhere in a coalesced run sets `interrupted: true` on the resulting `CortexMessage`; the field is optional and absent means not interrupted, so every existing consumer is unaffected.

## D6. What deliberately does not change

- `ChatProvider.chat` (non-streaming): still throws on abort. `"aborted"` is documented as producible only by an aborting streaming wrapper.
- `appendTurn` / `retractLastTurn` / `loadRecent` / `loadPage`: no schema, no predicate, no windowing change.
- The token-count column: the partial rows are counted by the same write-time tokenizer as any row.
- Emission contract: no new event type; the aborted terminal reuses the final `iteration` event.
