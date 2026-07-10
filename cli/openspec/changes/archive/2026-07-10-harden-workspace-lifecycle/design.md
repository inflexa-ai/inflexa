# Design — harden-workspace-lifecycle

## Context

`unify-analysis-workspace` made `<anchor>/.inflexa/analyses/<slug>/` the one place an analysis's files live. That was the right move, and it changed what the slug *is*: previously a label on a provenance-export folder, now the key to the user's run artifacts. Three lifecycle operations were written for the old meaning — delete, rename, and rename-to-the-same-name — and one performance assumption (the resolver is called rarely) stopped holding the moment the harness began calling it per file read.

## Goals / Non-Goals

**Goals:**
- A slug, once freed, never resolves onto the previous occupant's artifacts.
- No lifecycle operation moves or removes a directory the harness is actively resolving paths beneath.
- An analysis's own slug is not an obstacle to renaming it.

**Non-Goals:**
- A general "trash" or undo system. Archiving is one hop, into a visible sibling directory the user can inspect or delete themselves.
- Reclaiming archived trees automatically. They accumulate; that is the user's call.
- Making the resolver cheap enough to call per read *without* a memo. The derivation is inherently a few I/O ops; the fix is to call it less.

## Decisions

### D1 — Archive by default, delete on request

The user is deleting an *analysis*, not necessarily its *results*. A run may have taken hours of compute and its artifacts carry signed provenance. Silently `rm -rf`-ing them because the row went away is a data-loss default.

So the delete flow asks. "Keep the files" moves the tree to `.inflexa/analyses_archived/<slug>/`; "Delete the files permanently" removes it. Both satisfy the invariant that matters — the tree leaves `analyses/` — so the slug is safe to reuse either way.

*Rejected:* leaving the tree in place and refusing to reuse the slug (a tombstone). It makes `resolveOutputDir` depend on the filesystem's history rather than on the row, and the user's `analyses/` fills with directories belonging to analyses that no longer exist.

*Rejected:* suffixing new workspaces with a short id (`trial-a1b2/`). It removes the collision but makes every path the user sees uglier, permanently, to defend against a rare event.

### D2 — Dispose before deleting the row

Neither order is atomic, so choose by which failure is likelier and which is worse.

`deleteAnalysis` is a `DELETE` by primary key on a row just read — it essentially cannot fail. `disposeWorkspace` does filesystem I/O: permissions, an open handle, a full disk. Disposing first means the likely failure happens while nothing has changed, and the operation can simply be retried or abandoned. Row-first means the likely failure leaves the row gone and the tree at `analyses/<slug>/` — reintroducing exactly the bug this change exists to fix.

The residual risk (disposal succeeds, row delete fails) leaves a live analysis whose tree sits in `analyses_archived/`. It is reported, recoverable, and vanishingly rare.

### D3 — The rename guard is a caller-side predicate, not a lock

The tempting fix is a lock. But the thing we must exclude is *in-process concurrency* — a DBOS workflow running in the same TUI process that owns the rename dialog — and the existing per-analysis instance lock is re-entrant per pid by design (`lib/lock.ts`), so it cannot express "not while my own runs are live".

Instead `workspaceBusyReason(analysisId)` asks the three sources that can hold the tree: `chatStatus()` for a streaming turn, `profileWorkInFlight()` for the profile queue, and a `queryRunsByAnalysis` scan for a non-terminal run row (`execute_plan` returns before its durable workflow does, so chat status alone is not enough). An unreadable ledger refuses rather than guesses.

The check runs once, before the dialog opens. That is sound because the dialog is modal and blocks the composer, so no new work can start between the check and the action; already-running work can only finish, which is the safe direction.

*Rejected:* re-checking at submit time. It would need a second async hop inside a synchronous `onSubmit`, and buys nothing the modal does not already guarantee.

### D4 — Memoize the resolver in `output.ts`, not in `runtime.ts`

The hot caller is `createWorkspaceFilesystem`, which resolves per `read_file`/`grep`/`stat`. Every other caller (`open`, `launch`, `profile`) resolves once.

The memo lives in `output.ts` beside the derivation rather than in the `runtime.ts` closure, because the invalidation duty belongs to the operations that move a root — `renameAnalysisAndMoveWorkspace` and `disposeWorkspace` — and those are `analysis`-module code that must not reach into the harness embedder to clear a cache. It is process-local and starts empty, so the harness's recovery contract is untouched.

TTL is a backstop, not the mechanism: it bounds staleness from an anchor move made by *another* process (`inflexa relocate`, a folder moved between commands), which no in-process invalidation can observe. Five seconds is short enough that a stale root cannot survive a user noticing, and long enough to collapse a step's worth of file reads into one derivation.

### D5 — `resolveAnchor(…, { touch: false })` for root resolution

`touchAnchor` writes `last_seen`. Its meaning is "the user's folder was sighted". An agent reading a file is not a sighting, and `detectSourceAnalysis`'s doc comment already records that spuriously bumping the heartbeat corrupts it. Making the option explicit at the one non-sighting caller keeps the heartbeat honest and takes a synchronous SQLite write off the agent's read path — which, with D4, is now paid at most once per five seconds per analysis instead of once per read.

## Risks / Trade-offs

- **Archived trees accumulate.** Accepted, and deliberate: they are in a visible, obviously-named sibling directory, and the alternative default destroys the user's work.
- **The rename/delete guard can refuse when a run is wedged.** A genuinely stuck non-terminal run row blocks both until it is resolved. This mirrors `sidebar_live`'s existing trade-off (a wedged run keeps its poll armed) and is preferable to moving a directory out from under a live workflow.
- **The delete flow gained a second dialog.** One extra keystroke on a rare, destructive, irreversible action.
- **A five-second stale-root window exists after an out-of-process anchor move.** Bounded, and the same window already existed between the move and its reconciliation.
