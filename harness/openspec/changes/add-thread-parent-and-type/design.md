## Context

`cortex_analysis_threads` carries `thread_id`, `analysis_id`, `title`, `created_at`, `updated_at`, and `deleted_at` (`src/state/init.ts:273-283`). Every thread under an analysis is therefore the same kind of thing, and no row records which thread spawned it.

Two earlier changes cleared the ground for this one. Postgres is now the only home of session identity, and the store already carries the lifecycle verbs this change must define a cascade against: `archiveThread`, `unarchiveThread`, and `purgeThread` (`src/memory/thread-store.ts:210-249`).

One property of the surrounding schema drives most of the decisions below. `messages` carries **no** foreign key to `cortex_analysis_threads`. The only route from an analysis to its messages is a join through the thread table, which `purgeAnalysis` takes (`src/state/purge-analysis.ts:188-189`), and which `purgeThread` replaces with an explicit two-statement transaction (`thread-store.ts:243-249`). A thread row removed without its messages strands them permanently: nothing attributes them to an analysis, so no later reclamation of any scope reaches them.

## Goals / Non-Goals

**Goals:**

- Record what kind of session a thread is, and which thread spawned it.
- Pin the point in the parent's transcript that a child session was spawned from, so a report version has a frozen anchor.
- Define what each of the three lifecycle verbs does across the new parent/child edge.
- Keep every reclamation path free of orphaned `messages` rows.

**Non-Goals:**

- Selecting an agent from the type. That is the resolution seam in #236, which consumes the column this change adds.
- The Report Builder agent, its tool roster, and the spawn tool itself (#225).
- Grouping several report sessions into one named report. Report identity is `previewId` on disk, with `v{N}` under it and `baseVersion` carrying the lineage (see the `iterative-report` spec). The thread table stays out of it.
- CLI navigation. The boot-time thread filter is `cli` work against its own spec tree.

## Decisions

### One session per report version, as a flat child of the analysis conversation

An analysis conversation `X` spawns a report session `Y1`. More analysis work happens in `X`. A second request spawns `Y2`. `Y1` and `Y2` are both children of `X`, and neither refers to the other.

```
X   thread_type='conversation'  parent_thread_id=NULL  parent_seq=NULL
├── Y1  thread_type='report'    parent_thread_id=X     parent_seq=40
└── Y2  thread_type='report'    parent_thread_id=X     parent_seq=210
```

*Alternative rejected — one session per report, with versions inside it.* A session that emits v1 at one moment and v3 at a later one freezes twice, so a single `parent_seq` column on the row could pin only the spawn. The per-version anchors would need a second home, and "which moment is this version frozen at" would have two answers able to disagree.

*Alternative rejected — a chain, where `Y2`'s parent is `Y1`.* `parent_seq` would then index `Y1`'s transcript, while the checkpoint that #223 needs is a `seq` in the analysis conversation. The pair `parent_thread_id` + `parent_seq` stops describing one place.

### `parent_seq` lands in this change

One session holds one version, so it has exactly one freeze point. The anchor is well defined because `messages` is keyed `(thread_id, seq)` (`src/state/init.ts:265`). It is immutable once written, and #223 gets a guarantee rather than a column it must add later.

`createThread` SHALL reject a parent without an anchor. A CHECK constraint would express the pairing in DDL, but Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, and this schema's whole migration flow rests on idempotent statements. The rule therefore sits in `createThread`, beside the same-analysis check it already needs.

Both rules fire only when a caller supplies a parent or an anchor. First-turn conversation creation supplies neither (`src/app/chat-turn.ts:64-68`), so it is untouched.

### The foreign key does the existence check; application code does the rest

A probe against `pgvector/pgvector:pg18` inserted a row naming an absent parent and got `insert or update on table "t" violates foreign key constraint`. `tryMutation` already classifies a constraint rejection as the `constraint_violation` variant of `DbError`, which carries the constraint name (`src/lib/db-result.ts:45-50`). So the store issues no existence query — one round trip saved, and no window between a check and an insert.

Only the same-analysis rule and the anchor pairing need application code, because neither is expressible as a constraint on this schema. Those two return new error variants beside `DbError`, so `createThread`'s error channel widens. One production caller exists (`src/app/chat-turn.ts:64`), and it bridges through `unwrapOrThrow` inside a `try`, so the widening reaches nothing else.

The same probe settled what the idempotent path does. A create for an existing `thread_id` with an absent parent returned `INSERT 0 0` with no error, and the existing row was unchanged: `ON CONFLICT ... DO NOTHING` short-circuits before the constraint is evaluated. Nothing in this change alters that, and a caller that needs its supplied values persisted compares them against the returned row.

### `thread_type` is a closed set of two, validated at both edges

The set is `conversation` and `report`. Nothing in this change creates a `report` thread — the spawn action arrives with the Report Builder work — but the type exists now, because expressing a report session is the whole purpose of the column.

The set is closed rather than free-form because #236 resolves an agent from the type. That resolution can only be exhaustive over a set with known membership; a free-form column pushes an unmatched value into a fallback no reader can enumerate. It is a compile-time type on `Thread.threadType` and `CreateThreadInput.type`, and a run-time check in `createThread`, because a value crossing a package boundary or read from a row is outside the compiler's reach.

### The database cascade is a backstop; `purgeThread` deletes the subtree itself

The foreign key is `parent_thread_id TEXT REFERENCES cortex_analysis_threads(thread_id) ON DELETE CASCADE`. The cascade alone is **not** sufficient, and this is the sharpest constraint in the change: it removes a descendant's row but cannot reach that descendant's `messages`, because no foreign key connects them. The messages then survive with nothing naming them, unreachable by `purgeThread` and by `purgeAnalysis` alike — the exact orphan class `purgeThread` documents that it never creates (`thread-store.ts:28-35`).

`purgeThread` therefore walks the subtree with a recursive CTE, deletes every descendant's `messages` rows, then deletes the named row, all inside the transaction it already opens. The walk is recursive rather than one level deep for a specific reason: the column permits any depth, and the database cascade is recursive by nature, so a one-level explicit delete would leave a grandchild's messages behind exactly as the bare cascade does. The depth of the explicit delete must match the depth of the cascade.

The repository already uses this shape. `purgeAnalysis` deletes `cortex_plans` by explicit statement even where a cascade exists, because resting on the cascade makes the completeness of a purge depend on a constraint being present (`src/state/purge-analysis.ts:72-80`).

*Alternative rejected — `ON DELETE SET NULL`* (the form used by `cortex_runs.plan_id`, `init.ts:436`). The child would outlive its parent and read as a top-level session with no origin. *Alternative rejected — no action.* A verified probe shows the delete fails: `update or delete on table "t" violates foreign key constraint`. A user could then never delete a conversation that had produced a report.

### Archive cascades down; unarchive stays on one row

`archiveThread(X)` stamps `deleted_at` across the whole subtree, so a hidden conversation hides its report sessions with it. `unarchiveThread(X)` clears the stamp on `X` alone.

The asymmetry is what keeps the schema honest. A symmetric cascade would restore a child that the user had archived on its own beforehand, so the row would have to record whether a cascade or a deliberate action archived it — a fourth column carrying nothing else. With the asymmetry, no row needs that distinction, and every archived child is recovered the same way: by naming it.

### `listThreads` narrows only when asked

`type` and `parentThreadId` are optional exact-match filters. Omitting them returns every type, which is what a session picker wants — a user browsing an analysis's sessions expects to reach a report session directly. This is the opposite polarity to `includeArchived`, which widens a listing that is narrow by default (`thread-store.ts:67-75`), and the difference is deliberate: an archived thread is hidden state, and a report session is not.

### No new capability spec

`cortex_analysis_threads` has one owning spec, `harness-thread-store`. The parent/child model *is* the thread model, so a separate capability describing the same table would create a second source of truth for its columns and verbs.

## Risks / Trade-offs

**A future refactor moves `purgeAnalysis`'s thread delete ahead of its message delete → the cascade strands transcripts.** `ON DELETE CASCADE` makes any thread delete remove its whole subtree, including rows the predicate never named, so a descendant can lose its metadata row while its `messages` are still on disk. Those rows are then unreachable forever: `messages` has no foreign key, and the join through `cortex_analysis_threads` is the only route to them. Today the order is correct (`src/state/purge-analysis.ts:185-193`) and the `analysis-purge` spec gains a requirement pinning it.

Note what does **not** protect this. A parent-only delete under `ON DELETE CASCADE` succeeds — a probe against `pgvector/pgvector:pg18` returned `DELETE 1` and left zero rows of a three-generation tree — so it raises no referential error a caller could notice. The single-statement shape of the thread delete is therefore incidental, and only the ordering is load-bearing.

**A host purges a thread while a turn on a descendant is in flight → the descendant's messages persist unattributed.** This is the existing hazard of `purgeThread`, now reaching further: the rule "stop writes to a thread before purging it" (`harness-thread-store` spec, "Hard delete reclaims only what the host has stopped writing") extends to every thread in the subtree. The store cannot observe a host's in-flight turns, so it does not enforce it.

**An embedder lists threads without a type filter and binds the newest row → the user lands in a report session.** `resolveThreadId` in the CLI takes `page.threads[0]` (`cli/src/tui/hooks/thread.ts:86-87`), and a fresh report session is the most recently active row. The filter this change adds is what fixes it, applied in the `cli` subsystem.

**`parent_seq` records the spawn point, not a guarantee that the prefix still reads the same.** `retractLastTurn` (`src/memory/thread-history.ts:149`) can remove messages from the parent thread after a child pins an anchor beyond them. The anchor stays a valid `seq` value; it just may point past the parent's current tail. Resolving an anchor is #223's problem, and it must treat a short prefix as a normal state.

## Migration Plan

Three `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements plus one `CREATE INDEX IF NOT EXISTS`, added to the established additive block in `src/state/init.ts`. A probe confirmed the self-referencing form is accepted and that a re-run is a no-op (`column "parent_thread_id" of relation "t" already exists, skipping`).

No backfill runs. `thread_type` defaults to `'conversation'`, which is what every existing row is, and `parent_thread_id` and `parent_seq` are null on a row with no parent.

Rollback is a schema question only: the columns are additive and nothing existing reads them. `prepareChatTurn` names no type and no parent (`src/app/chat-turn.ts:64-68`), so it keeps producing the same row it produces today.
