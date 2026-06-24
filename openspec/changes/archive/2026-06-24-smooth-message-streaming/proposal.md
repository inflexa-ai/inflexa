## Why

Two message-rendering gaps undercut the chat UX. **(1)** Streaming text never appears live — the chat engine creates the assistant's part row but never broadcasts it before streaming, so the message sits in the store with `parts: []` and the accumulating `streamText` signal is bound to no renderable; tokens only materialize all at once when the turn ends. On a long reply the user stares at a blank screen with no signal the app is working. **(2)** The view mounts the entire session history (no `LIMIT` on the message load, whole array mapped into the store). `viewportCulling` clips painting, not layout, so layout/wrap cost grows with total history — the documented path to scroll/resize/stream lag in long sessions.

## What Changes

- The intelligence chat engine broadcasts the empty assistant part (a `part.updated`) immediately after creating it, before the stream loop — mirroring how the user part is already broadcast. This puts the streaming part into the store so the live token-by-token markdown renders as it accumulates.
- The conversation store loads only the **most-recent 200** messages of a session into the UI store, and trims the store back to 200 on each live message insert, bounding mounted layout cost regardless of total history length.
- A new capped message-read query returns the newest N messages (with their parts) in oldest→newest order. The existing uncapped `listSessionMessages` is unchanged and still feeds the engine's model-history build, which must see full context.

## Capabilities

### New Capabilities
<!-- none — all changes modify existing capabilities -->

### Modified Capabilities
- `intelligence-module`: the chat engine SHALL emit a `part.updated` for the empty assistant part before streaming begins, so the live stream renders incrementally (previously the empty part was never broadcast).
- `chat-view`: `loadMessages` SHALL load only the most-recent capped window (200) into the store, and the `message.created` reducer SHALL trim the store to the cap on insert; the live-stream-renders contract now holds end-to-end given the engine fix.
- `primary-storage`: a capped recent-messages read query SHALL exist that returns the newest N messages with their parts in oldest→newest order, alongside the existing uncapped full-history query.

## Impact

- `src/modules/intelligence/chat.ts` — one added `Bus.emit("part.updated", …)` for the empty assistant part before the stream loop.
- `src/tui/hooks/conversation.ts` — `loadMessages` calls the capped query; `applyBusEvent` `message.created` case trims to the cap.
- `src/db/primary_query.ts` — new capped query (`ORDER BY id DESC LIMIT N`, reversed to oldest-first); `listSessionMessages` untouched.
- Out of scope (YAGNI; add only if measured stutter): list virtualization/windowing, load-older pagination, large-message splitting, per-delta throttling.
