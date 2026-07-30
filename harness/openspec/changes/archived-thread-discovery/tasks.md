## 1. The returned shape

- [x] 1.1 Add `deletedAt: Date | null` to `Thread`, `deleted_at: Date | null` to `ThreadRow`, and map it in `toThread`.
- [x] 1.2 Add `deleted_at` to the column list of every statement whose rows reach `toThread` (`createThread`'s insert-returning and its read-back, `getThread`, `updateTitle`, `listThreads`), so no path constructs a `Thread` without the field.

## 2. The widened listing

- [x] 2.1 Add `includeArchived?: boolean` to `ListThreadsInput`.
- [x] 2.2 Make `listThreads`'s page query and its count query share one predicate that keeps `deleted_at IS NULL` unless the flag is set, so the total can never describe a different set than the page.

## 3. Coverage

- [x] 3.1 Test that the default listing still excludes an archived thread and counts only live ones.
- [x] 3.2 Test that `includeArchived` returns both, with a non-null `deletedAt` on the archived one and null on the live one.
- [x] 3.3 Test that the widened total and `hasMore` describe the live-plus-archived set under a `perPage` smaller than it.
- [x] 3.4 Test the round trip: archive, find it through the widened listing, `unarchiveThread` by the reported id, and see it in a default listing with a null `deletedAt`.

## 4. Verification

- [x] 4.1 `tsc -p tsconfig.json` clean and the full harness suite green.
- [x] 4.2 `bun run format:file` on every changed file under `src/`.
