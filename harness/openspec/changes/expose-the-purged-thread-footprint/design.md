## Context

`purgeThread` (`memory/thread-store.ts:519`) erases the rows of a whole subtree in one transaction. It gives back nothing. Its recursive walk already names every thread of that subtree.

A report session owns `report-sessions/{threadId}/` under the workspace root. `preview-report.ts:227` composes that path, and `examine-page.ts:353` composes the same layout again. The workspace layout spec names four directories and omits this one.

## Goals / Non-Goals

**Goals:**

- A host learns which threads a purge erased.
- One helper holds the layout of a report-session directory.
- An embedder reaches that helper without a deep import.

**Non-Goals:**

- The removal of any file. The store keeps its Postgres scope.
- A change to the archive verb, or to the restore verb. Neither erases a row.
- A prune of a session directory on any other trigger.

## Decisions

### D1. The store gives the ids, and it removes no file

`createThreadStore(pool)` takes a Postgres pool and nothing else. It has no filesystem seam, and the workspace root belongs to the embedder.

To hand it a root resolver would give a ledger a second responsibility that nothing else in it carries. It would also bind a store to a seam that a host with no local disk cannot realize.

Thus the store names what it erased, and the caller owns the bytes.

### D2. The purge gives back the ids, and not a count

A host must name each directory that it removes. A count answers no question that a caller can act on, and a boolean answers less.

### D3. The widened return, and not a read before the purge

A caller could list the subtree first, and then purge. That read and the transaction are two operations, and a spawn can add a child between them. The purge then erases a thread that the caller never saw, and its directory outlives every id that the caller holds.

The transaction already walks the set that it deletes. Thus the value comes from inside the one operation, where no window exists.

### D4. One helper composes the directory, and the front door carries it

Two tool modules spell `report-sessions/{threadId}` today. A layout that lives in two places breaks in one of them.

The helper sits beside `previewDir` in `workspace/paths.ts`, which is where the old preview tree already keeps its own. The front door exports it, because an embedder that removes the files must not restate a path of the harness.

### D5. An absent thread gives an empty set

A purge of a thread with no row succeeds today. It keeps that outcome, and it names nothing. Absence is a normal condition, thus it is not an error and it is not a special value.

## Risks / Trade-offs

- [The return type widens from nothing] → Accepted. A caller that ignores the value is unchanged, and `app/spawn-report-session.ts` is the one internal caller.
- [A host can ignore the ids] → Accepted. The reclamation is a host policy, and the harness states the fact rather than the duty.

## Migration Plan

The change is additive. A caller that awaits the purge and reads no value keeps its behavior.

## Open Questions

None.
