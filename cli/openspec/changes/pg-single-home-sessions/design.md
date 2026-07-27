## Context

Session identity is duplicated across two stores with no synchronization. The CLI SQLite `sessions` row (id, JSON blob with title/timestamps, `analysis_id` FK) is created eagerly at chat open, pre-boot, and its id is reused verbatim as the harness `threadId`; the Postgres `cortex_analysis_threads` row is created lazily by `prepareChatTurn` on the first turn. Renames touch only SQLite; the PG title keeps its first-message seed; SQLite deletes never reach PG; the SQLite `messages`/`parts` tables are frozen legacy with no writer and no reader; and `sessions.updatedAt` is bumped only by create/rename, so "most recent" ordering does not mean activity. The dev REPL (`inflexa chat`) already runs PG-only threads with no SQLite row.

The only structural reason the SQLite row exists is sequencing: the launcher (`resolveChatTarget`) resolves a session before `render()`, and the harness (with Postgres) boots fire-and-forget after render. Postgres itself is not scarce — the boot gate auto-starts a stopped container and auto-provisions a missing one, and the container is `restart: unless-stopped`, so it outlives CLI sessions.

This change lands before the multi-session model (#224 sub-issues #235/#236) so the new `parent_thread_id`/`thread_type` columns are born single-homed.

## Goals / Non-Goals

**Goals:**

- Postgres `cortex_analysis_threads` is the sole store of session identity, titles, and timestamps; the divergence bugs become unrepresentable.
- The launcher never touches session state pre-boot; passive paths stay PG-free (no-litter preserved, and the open-and-type-nothing SQLite litter row disappears).
- The TUI's session affordances (resume-most-recent, switch, rename, sidebar line) work unchanged from the user's point of view, now over the thread store.
- The SQLite chat tables and the `inflexa sessions` command are removed.

**Non-Goals:**

- Archive/hard-delete/purge lifecycle (#234) — this change keeps the existing soft `deleteThread` semantics where a delete affordance is needed.
- Parent/child linkage, thread types, agent selection (#235, #236).
- Making `analysis.delete`/`inflexa prune` clean up Postgres (#234); they keep today's behavior until then.
- CLI navigation UX beyond re-pointing what exists.

## Decisions

**1. Thread resolution moves to the boot-`ready` edge — not to a pre-render PG connection.**
The launcher resolves only the analysis (SQLite) and hands `App` analysis + working dir; a post-`ready` step resolves the thread: `ThreadStore.listThreads({analysisId})` → most recent live thread, else none. Alternative considered: connect to PG in the launcher (the container usually runs) — rejected because it drags container auto-start/provisioning into the pre-render phase for every launch, breaks no-litter on passive paths, and adds latency before first paint for zero UX gain (the chat is unusable before `ready` regardless: input is gated and the transcript lives in PG). Keeping a SQLite mirror for pre-boot reads was rejected as re-creating the divergence this change removes.

**2. The TUI mints the thread id at open; the row stays lazy.**
When no existing thread is picked, the TUI mints `randomUUIDv7()` as the thread id — an identity, not a row. The row is created exactly where it is today: by `prepareChatTurn` on the first turn. This keeps the turn engine's contract unchanged (a known `threadId` at send time), matches the REPL's existing new-by-default minting, and means abandoning an untouched chat persists nothing anywhere. Alternative — eager `createThread` at open to preserve the `Chat — <name>` title seed — rejected: it reintroduces litter, and the first-message-derived title is strictly more informative; the sidebar shows a placeholder until then.

**3. `Workspace.openSession` stays the single scope write path, carrying the thread id.**
The workspace scope's `sessionId` becomes the thread id (same value it always was on the TUI path); switch/rename palette commands and the sidebar re-point to `ThreadStore.listThreads`/`updateTitle`/`getThread` over the booted runtime's pool. The session-switch dialog and commands gate on boot `ready` (they are only meaningful then; today they silently operate on a store the chat can't use pre-`ready`).

**4. The existing `session.delete` palette affordance re-points to the soft `deleteThread` as an interim.**
The SQLite hard-delete disappears with the table. Removing the affordance entirely would regress the palette; wiring it to the existing spec'd soft delete keeps behavior (thread vanishes from listings) with less data loss than today, and #234 then splits it into archive vs hard delete. Accepted trade-off: until #234, "delete" tombstones rather than reclaims.

**5. Activity ordering ships as a decoupled harness companion change.**
`listThreads` orders by `updated_at DESC`, which today only `updateTitle` bumps. The companion harness change makes turn append touch the thread row's `updated_at`. The CLI change does not hard-depend on it: without the bump, `updated_at` ≈ creation/rename time — exactly the ordering SQLite gives today, so resume-most-recent degrades to the status quo, not below it. The CLI picks the behavior up by pinning the next harness release (CLI consumes the published package, not `file:`).

**6. The chat tables drop as versioned migration 2; the baseline stays v1.**
The forward-only versioned runner already supports appended migrations. The `data-model-storage` requirement that the schema is "a single version-1 baseline" is amended: baseline v1 plus a v2 drop of `sessions`/`messages`/`parts`. The legacy transcripts in `messages`/`parts` are deleted deliberately — they have been unreachable from the UI since the harness transcript became authoritative. Alternative — leave the tables in place unused — rejected: dead schema invites new readers and keeps the "which store is authoritative" question alive.

**7. `inflexa sessions` is removed, not ported to PG.**
Its output (global session ids) is consumable by no other command, and porting it would be the only headless surface requiring a PG connection story. Removal updates the agent-policy snapshot test, the e2e read-only sweep, and the `auth-session` scenario that used it as its example command (repointed at another read-only command, e.g. `inflexa ls`).

## Risks / Trade-offs

- [Migration deletes user data (legacy transcripts)] → deliberate and documented in the migration; the rows are unreachable by any UI today; users who care can back up the SQLite file before upgrading.
- [No session metadata when boot fails] → `failed` is already a terminal, actionable state; pre-`ready` the sidebar shows a placeholder. Nothing session-shaped worked in that state before either.
- [Title placeholder until the first message] → accepted UX change; PG derives the title from the first user message (better than the static `Chat — <name>` seed it replaces).
- [CLI/harness release coupling for the activity bump] → decoupled by design (Decision 5); ordering degrades to today's semantics, never below.
- [Orphaned PG threads from `analysis.delete`/`prune` remain until #234] → status quo, explicitly deferred; #234's `purgeAnalysis` closes it.
- [`chat-view`/turn-engine renames ripple widely (sessionId → threadId vocabulary)] → mechanical; the value and flow are unchanged on the TUI path.

## Migration Plan

1. Harness companion change (`updated_at` on append) lands independently in `harness/`; released and pinned by the CLI whenever ready.
2. CLI change lands whole: migration v2 + launcher/TUI re-point + command removal in one release, since the code paths and the tables must go together.
3. Rollback: migrations are forward-only; reverting the CLI binary restores the old code but not dropped tables — a rollback release would need a migration recreating empty chat tables. Acceptable: the tables' only live role was launch identity, which the old code rebuilds lazily (`resolveChatTarget` creates a session when none exists).

## Open Questions

_None blocking. The archive-vs-delete split, purge, and unarchive UX are #234's to answer; parent/child and type columns are #235's._
