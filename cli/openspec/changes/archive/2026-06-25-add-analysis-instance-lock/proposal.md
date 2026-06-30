## Why

An analysis can be opened in any number of `inf` instances at once — there is no detection or guard anywhere (no lock/owner/pid/heartbeat column on `analyses` or `sessions`, no single-instance guard; verified across the whole schema in `src/db/primary_migrations.ts` and a full-tree grep). Two terminals editing the same analysis write message/part rows under the same sessions concurrently, with no coordination. Opening an analysis that's already live elsewhere should be refused with a clear message instead.

## What Changes

- A **per-analysis advisory lock** is acquired whenever an analysis is opened for chat, and released when it's closed. The lock is keyed by analysis id (one analysis → many sessions, so locking the analysis — not the session — is what prevents two instances from sharing the work).
- **At launch** (`renderChat`, between `ensureProxyReadyOrExit()` and `render()` in `src/tui/app.launch.tsx`): if the analysis is already locked by a live instance, print `"<name> is already open in another instance"` to stderr and exit non-zero **before** the alternate screen is entered — no flash of TUI.
- **On in-process switch** (`openSession` in `src/tui/workspace.ts:73`, driven by Switch-analysis in the command palette): re-key the lock — **acquire the target before releasing the current one**; if the target is locked, keep the current lock, do not swap, and surface a warn `Notice`. "New analysis" mints a fresh id so it never conflicts.
- **Liveness is pid-based, not time-based.** A held lock records the holder's `process.pid`; a competing acquire reclaims the lock only if that pid is dead (`process.kill(pid, 0)` throws `ESRCH`). This differs deliberately from the existing time-staleness reclaim in the auth lock, because an analysis lock is held for an entire interactive session (possibly hours, mostly idle) where elapsed-time staleness would falsely free a live instance.
- **Release** is best-effort and ownership-checked: on graceful quit (`App.quit()`) and via a synchronous `rmSync` in `process.on("exit")`. A hard `kill -9` leaves a stale file, which the pid-liveness reclaim cleans up on the next open — no heartbeat or cleanup job needed.
- No `--force` override: dead-instance locks self-heal via pid reclaim; the only residual case (pid reuse after a crash) is rare enough to leave as a documented ceiling (manual file delete).

## Capabilities

### New Capabilities
- `analysis-lock`: the advisory per-analysis lock — acquire/refuse at launch, re-key on in-process switch (acquire-before-release invariant), pid-liveness reclaim of dead holders, and best-effort ownership-checked release on exit. Defines the conflict behavior (refuse + message at launch; keep-current + Notice on switch) and the lock-file location/format under the data dir.

### Modified Capabilities
<!-- None: locking is additive. No existing spec describes launch/switch/exit behavior that this changes — the lock is a new requirement layered onto those flows. -->

## Impact

- New file: `src/modules/analysis/lock.ts` (acquire / release / pid-liveness reclaim; single owner, called by launch + workspace). Modeled on the advisory-lock idiom at `src/modules/auth/auth.ts:357-428`, with pid-liveness substituted for time-staleness.
- Modified: `src/tui/app.launch.tsx` (acquire before `render()`, stderr+exit on conflict); `src/tui/workspace.ts` (`openSession` re-key with acquire-before-release + `Notice` on fail — `Notice`/`noticeColor` already exist in `theme.ts`); `src/index.ts` (sync release in the `process.on("exit")` hook); `src/tui/app.tsx` (release in `App.quit()`).
- Lock files live under the data dir (e.g. `<dataDir>/inf/locks/<analysisId>.lock`); path derives from `dataDir()` via `src/lib/env.ts` (the sole `process.env` reader) — no new env var.
- No new dependencies, no DB migration, no persisted-entity change. Satisfies the no-litter policy: a lock is written only on the deliberate open/switch action, never on the bare-`inf`-resolves-to-nothing path (acquire sits right before `render()`, which that path never reaches).
