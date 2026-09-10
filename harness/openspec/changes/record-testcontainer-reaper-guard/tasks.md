## 1. The guard

- [x] 1.1 Add `assertContainerWillBeReaped` in `src/__tests__/setup/require-reaper.ts`, which refuses on a disabled ryuk, on an unreachable runtime, and on a `getReaper` failure
- [x] 1.2 Call the guard from `startContainer` in `src/__tests__/setup/postgres.ts`, on the fallback path only
- [x] 1.3 Give the refusal message the two routes that start one container for the whole run

## 2. The accept-the-leak route

- [x] 2.1 Return early from the guard when `CORTEX_TEST_ALLOW_LEAKED_PG` holds a value
- [x] 2.2 Name `CORTEX_TEST_ALLOW_LEAKED_PG=1` and `TESTCONTAINERS_RYUK_DISABLED=true` together in the refusal message, because `GenericContainer.start()` calls `getReaper` after the guard passes

## 3. Tests

- [x] 3.1 Cover the two decisions that the guard reaches from the environment alone in `src/__tests__/setup/require-reaper.test.ts`
- [x] 3.2 Assert that the refusal names the reason and both safe routes
- [x] 3.3 Assert that the refusal names both variables of the accept-the-leak route

## 4. Documents

- [x] 4.1 Record the one-container-for-each-file behavior and the guard in the Testing section of `CLAUDE.md`
- [x] 4.2 Name both variables of the accept-the-leak route in `CLAUDE.md`
- [x] 4.3 Write the delta for `postgres-storage-backend` in this change

## 5. Verify

- [x] 5.1 `bun run typecheck` clean
- [x] 5.2 `bun test src/__tests__/setup/require-reaper.test.ts` green
- [x] 5.3 `bun run lint` clean for the changed files
