# Proposal

## Why

The `local-server` spec says that `POST {A}/chat` gives 404 for an absent thread. But the harness makes an absent thread at the open of its first turn. Each client depends on that, because no route makes a thread. Also, the route already gives 404 for an archived thread, because the harness claims a thread only when it is live. The spec does not name that refusal.

## What Changes

- The `local-server` spec states that an absent thread is not a refusal, because the first turn makes the thread.
- The 404 refusal of `POST {A}/chat` covers a thread of a different analysis and an archived thread.
- The JSDoc of `createChatTurn` in `src/client/conversation.ts` names the same refusals.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the requirement "The chat turn runs apart from its request" states the thread creation and the 404 refusals.

## Impact

- `openspec/specs/local-server/spec.md`.
- `src/client/conversation.ts` (a doc comment only).
- The route already maps the `not_found` result of the harness to 404, thus no route code changes.
