## Why

The running turn of a thread came from the turn registry of the server only. A restart empties the registry. A turn that a recovery runs after the restart, paused or not, thus did not show as a running turn. `GET {T}/turns` did not list it, and an ask on its thread was stale.

## What Changes

- The thread routes, `GET {T}/turns`, and the attention read also read the turn that holds a thread while its durable workflow is live.
- The turn of the registry wins when both sources give a turn of a thread.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the running turn of a thread, and the staleness of an ask.

## Impact

- `src/server/durable_work.ts`: `listLiveTurns`.
- `src/server/routes/conversation.ts`, `src/server/routes/attention.ts`.
