# Proposal

## Why

GitHub issue #678: `GET {T}/messages` gives the whole transcript of a session in one response (`src/server/routes/conversation.ts:264-279`). It reads each turn of the thread, and it sends one page that holds each turn. A long session holds hundreds of turns, with tool output in many of them. Thus the response and the work of the server grow with the session, with no bound. The web client renders the transcript, and it cannot bound the size of a page or of a response.

The harness change `page-the-session-transcript` gives a page read of whole turns, newest first, with a cursor. This companion change connects it to the route, to the client, and to the TUI.

## What Changes

- `GET {T}/messages` takes `limit` (default 20, maximum 100) and `before`, the cursor that an earlier page gave. It gives the newest turns before the cursor, in chat order. The new field `before` gives the cursor of the next older page, or `null` at the start of the session.
- The envelope keeps its fields. `total` counts the turns of the page, and `page` is 0. `perPage` is the limit that the server applied, and `hasMore` is true when an older page exists.
- A `before` value that does not have the form of a cursor gives 400 `validation_error`. A bad `limit` falls back to the default, the same as the other lists.
- The server reads only the turns of the page from the store.
- The client fetcher sends `before` and `limit`.
- The TUI keeps its window of the newest 200 messages. It reads pages at the maximum limit, newest first, until it holds 200 messages or no older page exists.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the list rule names the transcript read as the list that pages by a cursor, and a new requirement states the transcript read.
- `chat-view`: the transcript load reads pages until the window of 200 messages is full.

## Impact

- cli code: `src/api/conversation.ts`, `src/server/http.ts`, `src/server/routes/conversation.ts`, `src/client/conversation.ts`, `src/tui/hooks/conversation.ts`.
- cli tests: the route tests, the client tests, the TUI tests of the transcript load, the `ThreadHistory` fake in `src/modules/harness/turn.test.ts`, and each fixture that builds a `MessageList`.
- The harness: the route uses the page read of the harness change. Thus `bun run harness:local` comes before the typecheck and the tests.
- Each client that sends no cursor gets the newest page and not the whole transcript.
