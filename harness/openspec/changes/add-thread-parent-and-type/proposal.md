## Why

A report must leave the analysis conversation and run in its own session, owned by its own agent (issue #221). The thread model cannot express that today: `cortex_analysis_threads` records an analysis scope and a title, and nothing else. Every thread under an analysis is the same kind of thing, and no thread records which thread spawned it.

Two pieces of work sit behind this gap. The type→agent resolution seam (#236) needs a type on the thread row to key its lookup. The Report Builder agent (#225) needs a child session to run in. This change adds the two columns and the checkpoint anchor, and defines what the lifecycle verbs do across the new edge.

## What Changes

- **Three columns on `cortex_analysis_threads`**, all additive: `thread_type TEXT NOT NULL DEFAULT 'conversation'`, `parent_thread_id TEXT REFERENCES cortex_analysis_threads(thread_id) ON DELETE CASCADE` (the table's first foreign key, and a self-reference), and `parent_seq BIGINT` (the parent's `messages.seq` at the moment of the spawn — the frozen-at-T anchor #223 assumes). A partial index supports child listing.
- **`Thread` exposes the three fields**; `createThread` accepts `type`, `parentThreadId`, and `parentSeq`; `listThreads` gains a `type` filter and a `parentThreadId` filter.
- **`thread_type` is a closed set of two**, `conversation` and `report`, carried as a type on the store's public surface and checked at run time in `createThread`. Nothing here creates a `report` thread; the spawn action arrives with the Report Builder work. The set is closed because #236 resolves an agent from it, and that resolution can only be exhaustive over a known membership.
- **Integrity in `createThread`**: a named parent must belong to the same analysis, and a parent and an anchor must be supplied together. A parent that names no row is left to the foreign key, which rejects the insert as a `constraint_violation`. Every rule is conditional on a parent or an anchor being supplied, so first-turn conversation creation is untouched. `createThread`'s error channel widens to carry the two rules it enforces itself. This is data integrity, not authorization, so the store's no-scope-checks rule stands.
- **`purgeThread` reclaims the whole subtree.** It deletes each descendant's `messages` rows and metadata row inside the transaction it already opens. The database cascade stays behind it as a backstop, because `messages` carries no foreign key and a cascade alone would strand every descendant's messages beyond the reach of `purgeAnalysis`.
- **Archive cascades down; unarchive does not.** `archiveThread` stamps the whole subtree, so a hidden parent hides its report sessions. `unarchiveThread` clears the stamp on the named thread alone. The asymmetry is deliberate: it means no row has to record whether a cascade or a deliberate action archived it.
- **Creation semantics.** Lazy first-turn creation in `prepareChatTurn` keeps producing a `conversation` thread with no parent. A typed child thread is created eagerly by the deliberate spawn action.

## Capabilities

### New Capabilities

None. The multi-session model is the thread model, and `cortex_analysis_threads` already has one owning spec. A second capability describing the same table would be a second source of truth for it.

### Modified Capabilities

- `harness-thread-store`: the row gains three columns; the store surface gains the create inputs and the two list filters; `createThread` gains the parent-integrity rule; `archiveThread` and `purgeThread` gain subtree semantics, and `unarchiveThread` gains the rule that it stays on one row.
- `analysis-purge`: records that the message delete must run ahead of the thread delete, because the new self-reference cascades and would otherwise let a descendant's row go while its transcript stays on disk, unreachable.

## Impact

- **Schema**: `src/state/init.ts` — three `ADD COLUMN IF NOT EXISTS` statements and one partial index, in the established additive migration block.
- **Store**: `src/memory/thread-store.ts` — `Thread`, `CreateThreadInput`, `ListThreadsInput`, `ThreadRow`, `toThread`, and the `createThread`, `archiveThread`, `unarchiveThread`, `purgeThread`, `listThreads` bodies.
- **No change** to `src/app/chat-turn.ts`: its `createThread` call names no type and no parent, so the column defaults give it the `conversation` thread it already creates.
- **No change** to `src/state/purge-analysis.ts`: its thread delete is one statement over an `analysis_id` predicate, which removes parent and child rows together.
- **Unblocks** #236 (the type keys the agent lookup) and #225 (the Report Builder runs in a child thread).
- **Downstream of this change**, the CLI must filter its boot-time thread resolution to `conversation`. `resolveThreadId` binds the most recently active thread of the analysis, so an unfiltered listing would open a report session instead of the conversation. That work belongs to the `cli` subsystem and its own spec tree.
