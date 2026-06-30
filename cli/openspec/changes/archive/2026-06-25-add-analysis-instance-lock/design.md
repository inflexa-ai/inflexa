## Context

Opening an analysis in `inf` does nothing to claim it — two instances can open the same analysis and write message/part rows under its sessions concurrently (no lock/owner/pid column on `analyses` or `sessions`; verified in `src/db/primary_migrations.ts` and a full-tree grep). The codebase already has one advisory-lock idiom: the Auth0 refresh lock at `src/modules/auth/auth.ts:357-428` — an `O_EXCL` lock file with a `pid + timestamp` token and a stale reclaim. This change adapts that idiom to analyses, with one deliberate divergence (liveness signal).

Two flows open an analysis:
- **Launch** — `launchDefault`/`launchNew`/`launchResume` → `renderChat` in `src/tui/app.launch.tsx`, which calls `render(<App …>)` after `ensureProxyReadyOrExit()`. This is the normal-stdio phase, before the alternate screen.
- **In-process switch** — `ws.openSession(...)` (`src/tui/workspace.ts:73`), driven by Switch-analysis / New-analysis in `src/tui/commands.tsx`. The open analysis changes *without restarting the process*, so a launch-only lock would miss it.

Exit chokepoints: `App.quit()` (`src/tui/app.tsx:59`, graceful) and `process.on("exit")` (`src/index.ts:24`, sync-only). There is no `SIGINT`/`SIGTERM` handler in `src/`, and no hook survives `kill -9`.

## Goals / Non-Goals

**Goals:**
- Refuse opening an analysis that is already live in another instance, with a clear message, before the TUI takes over the terminal.
- Keep the guarantee correct under in-process analysis switching (re-key the lock).
- Self-heal locks left by crashed instances, with no cleanup job and no heartbeat.

**Non-Goals:**
- Read-only / view-only access to a locked analysis (refused outright instead).
- A `--force` takeover flag (dead locks self-heal; pid-reuse is a documented residual).
- Cross-machine coordination (the lock dir is local app-data; pid-liveness is meaningful only on one host).
- Locking at session granularity (the analysis is the unit of work).

## Decisions

### File lock under the data dir, keyed by analysis id

A lock is a file at `<dataDir>/inf/locks/<analysisId>.lock` containing the holder's pid, created with `writeFileSync(path, String(pid), { flag: "wx" })` (O_EXCL — atomic create-or-fail). Path derives from `dataDir()` through `src/lib/env.ts` (the only `process.env` reader); no new env var. Lives in a new single-owner module `src/modules/analysis/lock.ts`.

- **Alternative — DB column/table:** add `held_by_pid` to `analyses` or an `analysis_locks` table. Rejected: needs a migration, and the file-lock idiom already exists in `auth.ts`. A file is simpler and matches precedent.
- **Alternative — OS advisory locks (`flock`):** not in the stdlib surface used here; the `O_EXCL` file pattern is already proven in-repo.

### Pid-liveness reclaim, NOT time-staleness

On `EEXIST`, read the recorded pid and probe `process.kill(pid, 0)`: `ESRCH` → holder dead → reclaim (overwrite); no throw → holder alive → conflict.

- **Why not copy `auth.ts`'s time-staleness (30s):** the auth lock is held for ~seconds during one token refresh, so age is a fine liveness proxy. An analysis lock is held for the whole interactive session — possibly hours, mostly idle — so an age threshold would falsely free a live, idle instance and let a second one in. Pid-liveness is exact for the same-host case, which is the entire scenario.
- **Trade-off accepted:** pid reuse after a crash can make a free analysis look locked. Rare; residual escape hatch is deleting the lock file by hand. No `--force` (user decision).

### Two acquisition sites, two refusal styles

- **Launch** — acquire inside `renderChat`, between `ensureProxyReadyOrExit()` and `render()`. On conflict: stderr message + non-zero exit, before the alternate screen. Acquiring here (not in the resolvers) keeps the lock off the bare-`inf`-resolves-to-nothing path, satisfying the no-litter policy.
- **Switch** — acquire inside `openSession` (`workspace.ts:73`) with the **acquire-before-release invariant**: secure the target lock first; only then release the old and commit the swap. On conflict: keep the current lock, abort the swap, surface a warn `Notice` (`Notice`/`noticeColor` already exist in `theme.ts`). "New analysis" can't conflict (fresh id).

### Best-effort, ownership-checked release

Release on `App.quit()` (`app.tsx:59`) and via a synchronous `rmSync` in the `process.on("exit")` hook (`index.ts:24`). Release re-reads the file's pid and deletes only if it still matches this process, so it never removes a lock another instance reclaimed. `kill -9` leaves a stale file — acceptable, because the pid-liveness reclaim cleans it up on the next open.

## Risks / Trade-offs

- **Pid reuse after a crash** → a freed analysis reads as locked. → Rare on a single host within the relevant window; manual lock-file deletion recovers it. Documented; no `--force` by decision.
- **`kill -9` / panic leaves a stale lock** → next open's pid-liveness check reclaims it; no heartbeat or cron needed.
- **Switch-time acquire failure must not strand the user** → acquire-before-release invariant guarantees the current lock is never dropped unless the target is secured.
- **Networked/shared data dir** → pid-liveness is host-local and would be wrong across machines. → Out of scope; the data dir is local app-data.
- **Lock dir must exist** → ensure `<dataDir>/inf/locks/` is created (mkdir recursive) at acquire time; this is a deliberate write tied to the open action, consistent with the no-litter policy.
