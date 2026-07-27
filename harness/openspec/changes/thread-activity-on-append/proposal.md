## Why

`listThreads` orders by `updated_at DESC`, but the only mutator of `updated_at` is `updateTitle` — appending a turn never touches the thread row, so "most recently updated" means "most recently created or renamed", not "most recently active". Hosts that resolve "the most recent thread of this analysis" (the CLI does, once its SQLite session mirror is removed — issue #233) get a stale ordering the moment an older thread receives new messages. (Companion to the CLI change `pg-single-home-sessions`.)

## What Changes

- `appendTurn` additionally touches the thread row's `updated_at` in the same transaction that persists the turn, making `listThreads`' ordering mean activity.
- A missing thread row stays non-fatal: the touch updates zero rows and the append still succeeds (threads created lazily on the first turn get their row created by `prepareChatTurn` before the turn is appended, so the normal path always has a row).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `harness-thread-history`: the atomic-append requirement gains the thread-activity touch (same transaction as the turn's rows).
- `harness-thread-store`: the DI-factory requirement's listing semantics are updated — `updated_at` reflects activity (title updates and turn appends), so `listThreads` ordering is most-recently-active first.

## Impact

- `harness/src/memory/thread-history.ts` (`appendTurn` transaction gains one `UPDATE cortex_analysis_threads SET updated_at = NOW() WHERE thread_id = $1`).
- No schema change, no API-surface change, no workflow change. Consumers see fresher `listThreads` ordering; the CLI picks it up at its next harness version pin.
