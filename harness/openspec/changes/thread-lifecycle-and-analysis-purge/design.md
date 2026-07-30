## Context

`ThreadStore.deleteThread` writes a `deleted_at` tombstone and leaves the thread's `messages` rows untouched. It has no production callers in the harness; its only consumer is the CLI, whose UI already compensates for the misnaming by saying "Remove" and "the transcript is kept — nothing is erased". Alongside it, the harness has no analysis-delete path at all, so every embedder delete flow orphans the analysis's full Postgres footprint.

The proportions of that footprint were measured on a live database rather than inferred from the schema, because they decide the shape of the fix. Attributing `dbos.operation_outputs` by workflow class:

| Workflow class | Workflows | Step-output rows | Bytes | Reachable from an analysis id? |
|-|-|-|-|-|
| Analysis runs + child step workflows | 95 | 7098 | 16 MB | yes — `cortex_runs.run_id` *is* the parent workflow id |
| Scheduled (watchdog / reaper / sweep) | 442 | 389 | 93 kB | no |
| `dataprofile:{analysisId}:{nonce}` | 13 | 88 | 57 kB | yes — via the id namespace |
| Target assessment | 20 | 50 | 26 kB | no — separate entity |

Every analysis-keyed `cortex_*` table plus the per-analysis pgvector table sums to roughly 1.8 MB against that 16 MB. Two schema facts make the DBOS side tractable: every table in the `dbos` schema (`operation_outputs`, `streams`, `workflow_inputs`, `workflow_events`, `workflow_events_history`, `notifications`, `workflow_queue`) carries an `ON DELETE CASCADE` foreign key to `workflow_status`, and the system database is the same database as the app pool, so one pool sees both.

## Goals / Non-Goals

**Goals:**

- Two thread verbs whose names match their guarantees, plus the inverse of the soft one so "recoverable" is exercised rather than asserted.
- One harness-owned `purgeAnalysis` that reclaims an analysis's whole Postgres footprint, including the workflow rows that hold most of its bytes.
- A purge usable from a headless embedder process that never launched the durable runtime.
- Retryability: a failure partway leaves the remaining work still reachable.

**Non-Goals:**

- Retention or garbage collection of scheduled operational workflows. They belong to no analysis, `purgeAnalysis` can never reach them, and they grow independently of it. Naming this here is what keeps it from being mistaken for covered.
- Workspace file disposal — the embedder already ships it.
- Cascade rules between parent and child threads. Those are defined against these verbs by the data-model sibling, not here.
- Recovering `messages` rows whose thread row is already gone. They carry no analysis attribution, so nothing can attribute them.
- Any schema change. Every table, key, and id namespace the purge needs already exists.

## Decisions

**Purge covers the workflow footprint; it is not a follow-on.** A purge limited to the `cortex_*` tables and the vector index would reclaim roughly a tenth of an analysis and still present itself as the final, disk-reclaiming verb. The alternative — ship the table sweep now, add workflow coverage later — was rejected because the intervening releases would teach users that delete means delete while leaving the transcripts and run-event streams behind, and because the mapping from analysis to workflow ids lives in the very rows the table sweep deletes. Purging without it does not defer the work; it destroys the ability to do it.

**Delete order is: validate the analysis id → capture ids → cancel → delete workflow rows → delete `cortex_*` rows → drop the vector table.** The ordering is chosen for what a failure leaves behind. The validation comes first because it is the one refusal the operation can raise on its own, and a refusal is only useful while there is still something left to protect — raised from the drop stage it would report failure after everything was already gone, and would keep reporting it on every retry.

**The entry check validates the analysis id itself, and serves two jobs that must not be separated.** It bounds the id to a shape that is safe to interpolate as a SQL identifier once derived into a vector-table name, *and* it guarantees the id carries no `:`, which is the only reason the `dataprofile:{analysisId}:` namespace lookup is unambiguous — that lookup is a prefix match, so an id containing the delimiter would let a purge of `a` sweep `a:x`'s workflows into a cancel and a cascading delete. Validating the derived table name alone would satisfy the first job and silently satisfy the second by accident, which is worse than not satisfying it: the obvious refactor of moving the check next to the interpolation it protects would then re-open cross-analysis destruction with nothing failing. The check is therefore stated against the id, with both jobs named where it lives. `cortex_runs.run_id` and the `dataprofile:{analysisId}:` namespace are the only mapping from an analysis to its workflows, so the ids are read into memory next. Workflow rows then go *before* the ledger that names them: if the workflow stage fails, the mapping is still on disk and a retry finds it, whereas the reverse order converts a transient failure into a permanent orphan. Within the `cortex_*` stage, `messages` precede `cortex_analysis_threads` because they are reached by joining through it, and `cortex_analysis_state` goes last so that its cascade cannot outrun the statements before it.

**`cortex_plans` is deleted by its own statement, not by the cascade.** The foreign key from `cortex_plans` to `cortex_analysis_state` cascades, so on the schema the harness creates the statement is redundant. It exists because `CREATE TABLE IF NOT EXISTS` adds no constraint to a table that already exists, so a database whose `cortex_plans` predates that key never acquires one — and resting on the cascade alone would make the completeness of a purge contingent on a constraint being present, failing silently wherever it is not. The consequence for the ordering above is that "state last" is now a belt-and-braces detail rather than the mechanism: the plans are removed either way.

**The unit of recovery is idempotent retry, not one transaction across stages.** The purge spans the app tables, a DDL `DROP TABLE`, and the DBOS system schema through a separate client, so a single transaction is not available across all of it. Rather than fake atomicity, every stage is idempotent and the operation is safe to re-run, which the spec pins with "purging twice succeeds". Two places are atomic *within* a stage, both for the same reason — a half-done delete there is the orphan class the operation exists to avoid: the whole `cortex_*` stage runs in one transaction, so a mid-stage failure leaves no partly-deleted analysis, and `purgeThread` removes a thread's messages and its row together.

**Workflow reach goes through a `WorkflowPurger` seam.** The harness already quarantines the durability engine behind `RunLauncher` so tools and the loop never import it; a state module reaching for `DBOS` directly would open a second hole in the same wall. The considered alternative was raw SQL against `dbos.workflow_status` in the purge module, which has real precedent (`runtime/dbos.ts` and `sandbox/notification-sweep.ts` both do it). It was rejected because the SDK's own delete already does exactly the one `DELETE … WHERE workflow_uuid = ANY($1)` that the cascades need, plus the breadth-first descendant walk over `parent_workflow_id` that child step workflows depend on — reimplementing that walk in the state layer would duplicate engine-internal knowledge that the seam gets for free.

The seam carries three operations rather than the two the reclaim itself needs: cancel, delete, and a lookup of the workflow ids under a given id prefix. The lookup is there because an analysis's data-profile workflows are reachable only by querying the ledger for their id namespace, and a purge that ran that query itself would put the engine's schema back into the state layer — the exact coupling the seam removes. Keeping it on the seam means every statement against the `dbos` schema lives in the one realization that is already allowed to know about it.

**The seam's realization is built on `DBOSClient`, not the static `DBOS` facade.** `DBOS.deleteWorkflows` calls `ensureDBOSIsLaunched` and throws without a launched engine, which would make the purge unusable from exactly the headless path that needs it most. `DBOSClient.create({ systemDatabaseUrl, systemDatabasePool })` accepts a pre-built pool, needs no launch, and exposes the same `deleteWorkflow`/`deleteWorkflows`. One realization over the supplied pool therefore serves both a booted host and a headless one, so no embedder has to choose between two purgers.

**A purge is not serialized against work still starting, and says so.** The mapping from an analysis to its workflows is read once, up front. A run inserted after that read is outside the captured set, and the `cortex_runs` delete later in the same purge removes the only row that could ever have named it — so its workflow row and everything cascading off it belong to no analysis, and no retry reaches them. Locking the analysis for the duration was rejected: the purge spans a DDL drop and a separate system schema, so the lock would have to be held across work the store cannot bound. The honest alternative is the one the thread store already uses for the identical hazard — state the precondition (quiesce the analysis: no new runs, no new data-profile triggers) and narrow the outcome's promise, rather than let a host read "just re-run it" and conclude it may purge a live analysis.

**An absent ledger and a broken one are different answers.** The engine creates its schema at first launch, so a deployment that never launched has nothing to purge and must not fail. But keying that on the "undefined table" SQLSTATE alone conflates it with a `workflow_status` that has been renamed, dropped, or half-migrated out from under an existing schema — and that case would report a successful purge that reclaimed nothing, which is the one thing the operation must never do. The realization therefore settles it with a schema probe, taken only on the failure path and memoized only in the positive direction, since nothing drops the schema once it exists.

**The SQL identifier shape is owned by `vector-store.ts`.** It was duplicated there and in the purge, with divergent failure contracts — the write side throws, the reclaim side returns a `Result`. The obvious shared home is `search-config.ts` beside the name derivation, but that file already imports the vector store, so putting it there creates an import cycle. The vector store already declared the shape, so it keeps it and exports a predicate the reclaim side consumes; the write side's throw is left alone as a pre-existing decision on a different path. The bound is part of the shape, not a separate check: Postgres truncates identifiers at 63 bytes silently, so two long ids sharing a prefix would derive one table name — a write into another resource's index before this change, and a drop of it after.

**`appendTurn`'s tolerance of a missing thread row is left alone.** "A missing metadata row does not fail the append" is an existing, deliberate requirement in `harness-thread-history`, and `messages` carries no foreign key to `cortex_analysis_threads`. Making the append refuse would close the resurrection window at the source, but it reverses a specified behaviour that legacy and REPL-created threads rely on. Instead the limit is stated: hard delete guarantees it creates no orphan of its own, and a host stops writes to a thread before deleting it. The CLI already implements exactly that discipline for the soft path — it unbinds the thread to `null` before re-landing — so the obligation is a documented existing practice, not a new burden.

**`deleted_at` keeps its column name.** The verb is renamed; the tombstone column is not. Renaming it would be a migration on a column three modules already filter on, buying nothing but vocabulary.

## Risks / Trade-offs

- **A `DBOSClient` operating beside a launched engine in the same process** → It is a separate client over the same system database, and the deletes it issues target workflows the purge has already cancelled. Order cancel-then-delete strictly, and treat cancellation failure as fatal to the purge rather than proceeding.
- **Cancellation is not instantaneous, so a workflow may write once more between cancel and delete** → The purge is idempotent and re-runnable; a re-run reclaims anything a late write left. This is why "purging twice succeeds" is a requirement and not merely a nicety.
- **A hard delete racing an in-flight turn strands messages permanently** → Stated as a limit in the spec with the host obligation to stop writes first. Not silently absorbed: the store makes no claim to have removed them.
- **`DROP TABLE` on the vector index takes an `ACCESS EXCLUSIVE` lock** → A concurrent workspace search against the same analysis blocks briefly, then fails against a dropped table. Acceptable: the analysis is being destroyed, and any reader still searching it is already operating on a doomed target.
- **The purge reports counts, so a host may narrate a reclamation that a later orphan contradicts** → The outcome reports what this invocation removed, not a claim that nothing anywhere remains; the spec's "names what it does not reach" requirement keeps the exclusions on the record.
- **Retiring the `deleteThread` name rather than repointing it at the hard delete** → Repointing would leave the behavioural inversion invisible to the compiler: the signature is unchanged, so a consumer upgrades into silent transcript loss on a call site nobody edited, guarded only by someone reading a changelog. Removing the name makes the break mechanical — a stale call site fails to build. This also avoids the objection to merely *adding* `purgeThread`, which would have left a misnamed soft `deleteThread` in the surface indefinitely; retiring it satisfies both concerns at once. Every current caller is in the paired embedder, so the blast radius is one repository.

Four properties are believed rather than tested, and are recorded here rather than left to look covered:

- **"No rows reappear after a cancel" is unproven.** Every workflow row in the suites is hand-seeded `PENDING`, so there is no executor that could re-materialize anything. Proving it needs a rig that starts a genuinely long-running workflow, purges it, and re-counts after a delay.
- **The engine quarantine has no mechanical guard.** That the state layer imports no durability engine is true today by inspection, but `eslint.config.js` carries no import-zone rule, so nothing stops the next edit. Note the quarantine is about imports: `state/data-profile.ts` already issues raw SQL against `dbos.workflow_status`.
- **`searchIndexName`'s process-lifetime memo of created index tables is not invalidated when a purge drops one.** A host that purged an analysis and then met the same derived index name again would skip the create and fail every upsert. Unreachable while analysis ids are never reused, which is why it is noted rather than fixed.
- **The workflow-purge realization hardcodes the `dbos` schema** while the client accepts a configurable schema name. The two agree in every current configuration, and would diverge only if an embedder set it.

## Migration Plan

No schema migration. The change is a source-compatible addition (`archiveThread`, `unarchiveThread`, `purgeThread`, `purgeAnalysis`, the seam) plus one removal (`deleteThread`), which is a compile break rather than a behavioural one.

The break lands with its consumer. The CLI consumes the published harness from the registry, so a harness change is invisible to it until the version pin moves; the companion CLI change re-points the session-remove flow at `archiveThread` and adds the delete verb in the same commit that bumps the pin. Local verification of the pair requires `bun run harness:local` — a plain reinstall restores the registry snapshot and hides the break. Run the CLI typecheck at the pin-bump commit, since a harness export change surfaces in CLI CI only there.

Rollback is a pin revert: nothing in this change writes state that an older harness cannot read, because it only ever removes rows.

## Open Questions

- **What `inflexa prune` does when Postgres is unreachable.** The issue framed it as warn-and-proceed versus refuse, but the embedder's existing `ensurePostgresReady` is self-healing — it writes the compose file, starts containers, and installs pgvector. So wiring prune to it neither warns nor refuses; it starts the container stack from a headless command. That is defensible for a deliberate action, but it should be chosen rather than inherited from the convenient helper. Deferred to the CLI companion change, where the decision lives.
- **Whether the purge outcome should be reported per-store or as a total.** The spec requires threads, messages, workflows, and the vector-index flag; whether an embedder wants finer attribution is a UX question the first consumer answers.
- **Retention for the scheduled-workflow rows.** 442 of 557 `workflow_status` rows on the measured database belong to the watchdog, reaper, and notification sweep. Out of scope here by construction, and worth its own issue rather than a silent accumulation.
