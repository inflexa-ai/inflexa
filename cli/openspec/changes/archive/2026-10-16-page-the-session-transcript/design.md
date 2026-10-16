# Design

## Context

- The route reads the thread with `opts.loadTurns`, bound to `createThreadHistory(pool).loadAll` (`src/server/routes/conversation.ts:76-77`, `:101`). It replays `loaded.flat()` with `storedMessagesToChat`, and it builds the body with `listEnvelope` (`:264-279`).
- `listEnvelope` computes `hasMore` from `page`, `perPage`, and `total` (`src/server/http.ts:79-84`). `parseCount` caps each count at `MAX_PER_PAGE`, 200 (`:58-65`). The attention route reads its `limit` with `parseCount` (`src/server/routes/attention.ts:81`).
- The rename route gives a hand-built `validation_error` (`src/server/routes/conversation.ts:201`). `readBody` gives the `z.flattenError` output (`src/server/http.ts:49-57`).
- `fetchMessages` sends no query value (`src/client/conversation.ts:101-103`).
- The TUI reads the transcript in `mountTranscript` (`src/tui/hooks/conversation.ts:891-922`) through `LoadOpts.fetchMessages` (`:810-820`). It mounts `messages.slice(-MESSAGE_CAP)`, with `MESSAGE_CAP` 200 (`:57-66`). Each await re-checks the token `loadGeneration`. The comment above `MESSAGE_CAP` says that the read of the store has no ceiling.
- `healTailOrphan` (`src/modules/harness/turn.ts:279-287`) reads the tail turn with `loadAll`. It stays.

## Goals / Non-Goals

**Goals:**

- One route read costs the turns of one page.
- The TUI shows the same window as before.

**Non-Goals:**

- No change of the turn list `GET {T}/turns`, and no change of `healTailOrphan`.
- No TUI read of the turns older than its window. The cap stays.
- No count of the turns of the thread.

## Decisions

### D1. The wire shape

In `src/api/conversation.ts`:

- `MessageList` becomes `Omit<ListEnvelope<"messages", ChatMessage>, "total"> & { total: number; before: string | null }`. The JSDoc of `ListPage.total` says that `total` counts each item of each page (`src/api/common.ts:58-59`). Thus `MessageList` declares its own `total` and `before`, each with a JSDoc that states its meaning for this list.
- `MessagePageQuery = { before?: string; limit?: number }`.
- `DEFAULT_TRANSCRIPT_TURNS = 20` and `MAX_TRANSCRIPT_TURNS = 100`.

The cursor is a string on the wire. The harness `seq` is a `bigint`, and a string keeps the cursor opaque to a client. The server makes it with `String(page.before)`.

### D2. `total` counts the turns of the page

A count over the thread reads each row, and the requirement forbids it. Thus `total` is `page.turns.length`, `page` is 0, and `perPage` is the applied limit. `hasMore` is `before !== null`. The route builds this body itself, because `listEnvelope` computes `hasMore` from `total`.

Alternative: `total` from `cortex_thread_turns`. A thread that an older version wrote has no turn record, and a host record makes no turn record. Thus that count is wrong for such a thread.

### D3. The query values of the route

- `limit`: `parseCount(c.req.query("limit"), DEFAULT_TRANSCRIPT_TURNS, MAX_TRANSCRIPT_TURNS)`. Give `parseCount` an optional maximum, with `MAX_PER_PAGE` as the default. Thus the existing callers do not change. Make sure that `src/server/http.test.ts` covers the new maximum.
- `before`: validate it with a zod schema, a string of decimal digits whose number is a safe integer. An empty string is a refused value. A refused value gives `apiError(c, "validation_error", …, z.flattenError(…))`, the same as `readBody`. The validation runs before the thread read, thus a bad cursor reads nothing.

A bad cursor gives 400, but a bad `limit` falls back. A fallback of a cursor gives the newest page again. A client that asks for an older page then gets the same turns again, and the client cannot see the fault.

### D4. The route option

Replace `loadTurns` in `ConversationRouteOpts` with `loadPage: (pool, threadId, options: LoadPageOptions) => ResultAsync<TurnPage, DbError>`. The production binding is `createThreadHistory(pool).loadPage(threadId, options)`. The route test stub records the options that it receives. Thus a test shows that the route passes the cursor and the limit, and that it reads no other turn.

### D5. The client fetcher

`fetchMessages(analysisId, threadId, query: MessagePageQuery = {}, opts)` sets `before` and `limit` in the query string only when the query holds them. `src/client/conversation.test.ts` covers the query string.

### D6. The TUI reads pages until the window is full

`LoadOpts.fetchMessages` takes a cursor: `(analysisId, threadId, before?: string) => ResultAsync<MessageList, ClientError>`. The production binding sends `limit: MAX_TRANSCRIPT_TURNS`. `mountTranscript` reads the newest page. Then it reads the next older page while it holds fewer than `MESSAGE_CAP` messages and the cursor is not `null`. It puts each older page in front of the messages that it holds. Then it mounts the newest `MESSAGE_CAP` messages.

The token check runs after each await, thus a newer load drops a load in the middle of its pages. A page read that fails ends the load with the existing handling of that failure: a 404 mounts an empty transcript, and each other error goes to the failure path. Correct the comment above `MESSAGE_CAP`.

Alternative: one read of 100 turns. A turn gives at least 1 message, but an aborted turn with no reply gives only 1. Thus 100 turns can hold fewer than 200 messages, and the window of the chat-view requirement is then short.

## Risks / Trade-offs

- Risk: a long thread of turns with no reply costs the TUI more than one read. Mitigation: each read holds 100 turns, and the loop stops at the cap. A normal turn gives at least 2 messages, thus one read fills the window.
- Risk: the web client and the TUI see a different `total` than before. Mitigation: no client reads `total` of this list. The TUI reads `messages` only.
