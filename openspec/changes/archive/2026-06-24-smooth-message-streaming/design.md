## Context

The chat stream is rendered by `Chat` (`src/tui/components/chat.tsx`) over a `<scrollbox stickyStart="bottom">`, one `MessageBlock` per message. Hot state lives in `src/tui/hooks/conversation.ts`: a `messages` store plus `streamText`/`streamPartId` signals. The engine (`src/modules/intelligence/chat.ts`) drives persistence and emits bus events that `applyBusEvent` reduces into that state.

Two defects, both verified against source:

1. **Streaming is invisible.** The engine emits `message.created` for the assistant turn (`chat.ts:85`) but never a `part.updated` for the empty assistant part it just created — that broadcast happens only *after* the stream loop (`chat.ts:128`). So during streaming the assistant message holds `parts: []` (`conversation.ts:80-88`), `part.delta` writes only the `streamText`/`streamPartId` signals (`conversation.ts:110-118`), and `MessageBlock` (`message_block.tsx:41-56`) — which reads `streamText` *inside* a text part's render — has no part to render. Tokens appear only at turn end. The unit test passes only because it manually injects the placeholder the engine omits (`conversation.test.ts:67`).
2. **Unbounded mount.** `listSessionMessages` (`primary_query.ts:29`) has no `LIMIT`; `loadMessages` (`conversation.ts:130-138`) maps the whole array in. `viewportCulling` clips paint, not Yoga layout, so layout/wrap cost scales with total history.

This mirrors the OpenCode TUI analysis: the fast path is incremental ID-keyed updates + native streaming markdown + a hard mount cap — not virtualization.

## Goals / Non-Goals

**Goals:**
- Live token-by-token rendering during a streamed assistant turn.
- Mounted message count bounded to 200 regardless of total session length, on both initial load and live inserts.
- No regression to the model-history context the engine builds (it must keep seeing full history).

**Non-Goals:**
- List virtualization / windowing, load-older pagination, large-message splitting, per-delta throttling. All deferred (YAGNI) until a measured stutter justifies them.
- Reaching messages older than the 200-cap from within the TUI (matches OpenCode; the data is never lost on disk).

## Decisions

**Decision 1 — Fix streaming engine-side, not store-side.** The engine broadcasts a `part.updated` for the empty assistant part right after creating it (before the stream loop), symmetric with how the user part is already broadcast (`chat.ts:55`). Once that placeholder is in the store, `streamPartId === part.id` makes `MessageBlock`'s `content()` read `streamText`, so the live markdown renders.
- *Alternative considered:* have the store reducer synthesize a placeholder part on the first `part.delta` for an unknown `partId`. Rejected — it puts engine-shaped knowledge (part identity/shape) into the UI reducer, and the engine already owns the DB row; broadcasting it is the smaller, more honest change and matches the existing user-part pattern.

**Decision 2 — Capped query is a new function, not a `LIMIT` on the existing one.** Add a capped recent-messages query (`ORDER BY id DESC LIMIT N`, then reverse to oldest-first, parts assembled as today) and point only `loadMessages` at it. `listSessionMessages` stays uncapped because the engine's `toModelMessages` build (`chat.ts:67`) needs full context.
- *Alternative considered:* add an optional `limit` parameter to `listSessionMessages`. Rejected — a defaulted limit risks a caller silently capping the model history; two named functions make "UI window" vs "full history" legible at the call site (the same id-first-in-SQL discipline the repo already uses).

**Decision 3 — Re-enforce the cap on live insert.** `applyBusEvent`'s `message.created` case trims the store to the cap by dropping the oldest message after pushing. A turn pushes user+assistant (2/turn), so a long live session would otherwise exceed the load-time cap.

**Decision 4 — Cap = 200 turns.** Comfortably exceeds a screenful and ~2× OpenCode's 100; a turn is one user/assistant message, so 200 ≈ 100 exchanges.

## Risks / Trade-offs

- [Placeholder broadcast lands an empty part in the store before any delta] → `MessageBlock` wraps the markdown in `<Show when={content()}>`, so an empty part renders nothing until the first delta; no empty block flashes.
- [Idle-flush double-writes the final text — `part.updated` at `chat.ts:128` then the idle flush in `conversation.ts`] → identical value written twice; harmless, already the case today.
- [200-cap makes older messages unreachable in-TUI] → accepted, matches OpenCode; disk retains everything and a load-older affordance remains a clean future addition.
- [Capped query returns newest-N but must render oldest-first] → reverse after the `DESC LIMIT`, exactly the server pattern OpenCode uses; covered by a scenario.
