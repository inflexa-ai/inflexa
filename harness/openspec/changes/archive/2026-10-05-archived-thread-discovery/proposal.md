## Why

`unarchiveThread` cannot be called. It takes a `threadId`, and once a thread is archived no API in the store returns one: `getThread` and `listThreads` both filter `deleted_at IS NULL`, `ListThreadsInput` has no way to ask for archived rows, and `Thread` carries no field that would distinguish an archived row from a live one even if a caller held it. A host can only unarchive a thread whose id it stored somewhere outside the harness, or that a human read out of Postgres by hand.

So the store promises a recoverable archive and ships the verb that performs the recovery, while withholding the one thing a host needs to reach it. Now is the moment to close that: the thread-lifecycle split has not been released, so fixing it here means the archive/restore pair ships whole rather than as a capability that a later version has to make usable.

## What Changes

- `ListThreadsInput` gains an optional `includeArchived` flag. Omitted or `false` preserves today's behaviour exactly — live threads only — so every existing caller is unaffected.
- **BREAKING** `Thread` gains `deletedAt: Date | null`, the field that tells an archived row from a live one. Required rather than optional: every row has one of the two states, and an optional field would let a host that lists archived threads forget to distinguish them — the single mistake this change exists to prevent. Consumers that only read a `Thread` are unaffected; the break falls on code that constructs one, which in practice is test fixtures.
- `listThreads` returns archived threads alongside live ones when asked, in the same `updated_at DESC` order, with the total and `hasMore` counting the same set the page was drawn from.
- `getThread` is deliberately unchanged: an archived thread stays indistinguishable from an absent one there. Hosts rely on that to treat a removed conversation as gone, and a restore flow reaches its target by listing, never by id lookup.

## Capabilities

### New Capabilities

None — this extends an existing store's read surface.

### Modified Capabilities

- `harness-thread-store`: the thread-listing requirement gains the archived-inclusion behaviour, and the DI-factory requirement's description of `Thread` and `listThreads` is restated to cover the tombstone field.

## Impact

- `harness/src/memory/thread-store.ts` — `Thread`, `ListThreadsInput`, `ThreadRow`, `toThread`, and both statements behind `listThreads` (the page query and its count).
- `harness/src/memory/thread-store.test.ts` — coverage for the flag's default, its effect, and the ordering/count agreement.
- No barrel change: `Thread` and `ListThreadsInput` are already exported from `src/index.ts`, and adding fields does not change the export list.
- Embedders that construct a `Thread` (test fixtures in the paired CLI) fail to compile until they add `deletedAt`. That break surfaces only when the harness version pin moves, alongside the `deleteThread` removal already shipping in the same release.
