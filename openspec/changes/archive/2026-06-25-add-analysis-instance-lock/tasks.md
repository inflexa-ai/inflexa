## 1. Lock module

- [x] 1.1 Create `src/modules/analysis/lock.ts` (single owner; modeled on `src/modules/auth/auth.ts:357-428`). Derive the locks dir from `dataDir()` via `src/lib/env.ts` (no new env var); `mkdir` it recursively on first acquire. Lock path = `<locksDir>/<analysisId>.lock`.
- [x] 1.2 `acquireAnalysisLock(analysisId)`: `writeFileSync(path, String(process.pid), { flag: "wx" })`. On `EEXIST`, read the recorded pid and probe `process.kill(pid, 0)` — `ESRCH` → reclaim (overwrite with our pid, return success); otherwise return a conflict result (do not throw). Return a typed result distinguishing acquired vs conflict (Result/union per `lib/types.ts`), not a bare boolean.
- [x] 1.3 `releaseAnalysisLock(analysisId)`: ownership-checked — re-read the file's pid and `rmSync` only if it equals `process.pid`; never delete a lock another instance reclaimed. (Deviation: one **sync** function, not async+sync — `rmSync` is synchronous, so an async wrapper would be pointless ceremony; a sync fn works fine in the async `App.quit` too. Added `releaseHeldAnalysisLock()` for the exit hook, which releases this process's tracked `heldAnalysisId`.)

## 2. Launch integration

- [x] 2.1 In `renderChat` (`src/tui/app.launch.tsx`), acquire the lock for the resolved analysis between `ensureProxyReadyOrExit()` and `render()`. On conflict: print `"<analysis name> is already open in another instance"` to stderr and exit non-zero (via `shutdown(1)`) before the alternate screen — do not call `render()`.

## 3. In-process switch

- [x] 3.1 In `openSession` (`src/tui/workspace.ts:73`), apply the acquire-before-release invariant: acquire the target analysis's lock first; only on success release the previous analysis's lock and commit the swap. On conflict: keep the current analysis, retain its lock, abort the swap, and surface a warn `Notice` (`Notice`/`noticeColor` from `theme.ts`) naming the conflicting analysis. Confirm "New analysis" passes through with a fresh id (no conflict possible).

## 4. Release on exit

- [x] 4.1 Release the currently-held analysis lock on graceful quit. (Deviation: NO separate `App.quit()` edit — `App.quit()` calls `shutdown(0)` → `process.exit(0)`, which fires the `process.on("exit")` hook from 4.2. That single sync hook covers graceful quit and every other `process.exit`, so a second release site would be redundant.)
- [x] 4.2 Add a synchronous `releaseAnalysisLockSync` call to the `process.on("exit")` hook in `src/index.ts:24`, releasing the lock held by this instance (track the currently-held analysis id at module scope).

## 5. Verification

- [x] 5.1 Unit-test `lock.ts` (e.g. `src/modules/analysis/lock.test.ts`): acquire-free succeeds; second acquire while held conflicts; acquire reclaims when the recorded pid is dead; ownership-checked release leaves a foreign-pid file untouched. Use a temp data dir; simulate a dead holder by writing a pid known to be absent.
- [x] 5.2 Run `bun run format:file` on changed `src/` files, then `bun run typecheck` and `bun run lint`; all clean.
