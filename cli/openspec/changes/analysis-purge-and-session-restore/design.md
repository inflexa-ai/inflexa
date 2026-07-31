## Context

`deleteAnalysisWith` disposes the workspace and then deletes the SQLite row, in that order and only if the disposal succeeds — the filesystem move is the operation that realistically fails, so attempting it first means a failure changes nothing. Postgres has never been in the ladder. The harness now offers `purgeAnalysis(analysisId)`, which reclaims the analysis's `cortex_*` rows, its vector index table, and the durability-engine ledger those rows are the only mapping to.

Two existing facts shape where the new stage goes. The SQLite row is the only record of the analysis id the CLI holds, and `purgeAnalysis` needs that id. And the purge is idempotent and re-runnable by contract, while the workspace move is not.

Separately, archiving a conversation is now called what it is. `deleteThread` is gone; the flow that used it always wrote a tombstone and kept every message, which is `archiveThread`. The restore direction has no surface at all today.

## Goals / Non-Goals

**Goals:**

- No delete leaves an analysis's Postgres footprint behind, on either disposal branch.
- A failure anywhere in the ladder leaves the deletion retryable rather than half-done.
- The signed provenance document survives inside a workspace the user chose to keep.
- An archived conversation can be found and restored without leaving the app.

**Non-Goals:**

- Reclaiming analyses already deleted. Their ids are gone from SQLite, so they need a discovery pass of their own — a separate change, and one that must never run automatically, since a restored older `agent.db` would present live analyses as reclaimable.
- Serialising a purge against work still starting. The harness states that precondition and cannot enforce it — it cannot observe a host's in-flight work — so meeting it is this change's job, not something to build machinery for. Both purge surfaces meet it with a gate ahead of their confirmation: the analysis delete with the existing workspace busy check, the conversation delete with the chat's own activity state. Neither holds a lock; both refuse and let the user retry.
- Restoring a conversation by binding it to the chat. Restore returns a thread to the listing and stops there — the switch picker is how a user opens one, and yanking them off what they are reading would be a navigation they never asked for.

## Decisions

**The SQLite row dies last.** The ladder is: flush and export provenance → dispose the workspace → purge Postgres → delete the row. Every other order can strand data permanently. Deleting the row before the purge discards the only id that names the Postgres footprint, which is precisely the mechanism that produced the orphans this change exists to prevent — and it fails *silently*, because the delete reports success. With the row last, any earlier failure leaves a retryable state: the tree is already archived (a second attempt reports `absent`, which is not an error), the purge is idempotent, and the analysis is still listed so the user can try again.

**A purge failure aborts the deletion.** The alternative — carry on and delete the row anyway — converts a recoverable failure into a permanent orphan. Aborting costs the user a retry; proceeding costs them a leak they can never find. The notice says nothing was lost, because nothing was.

**Purge runs on both disposal branches.** The "keep the files?" question has only ever governed the workspace tree: both branches already delete the SQLite row and, with it, the signed provenance chain. Postgres holds the same class of state that row does — ledgers, transcripts, indexes — not user artifacts. Purging only on permanent deletion would leave the *default* branch orphaning, which is the status quo this change exists to end.

**Provenance is exported before the disposal, not after.** The export writes into the analysis's live output directory. After a disposal, that path no longer exists, and the export's `mkdir` would recreate `analyses/<slug>/` containing a single file — resurrecting the very directory the disposal exists to clear, ready for the next analysis of the same name to inherit. Running first means the document is written into the tree and moves with it.

**The export is flushed first, and its failure is tolerated.** `serializeProvenance` reads the persisted column, not the in-memory recorder, and the recorder flushes on a dirty-set schedule; deleting an analysis right after working in it is exactly when appends are still in memory. Without a flush the archive would keep a document missing the session's tail. The failure is tolerated because the user asked to delete an analysis, not to export provenance — refusing their request over a courtesy would be the wrong trade. What is *not* tolerated is a silent one: a failed export is reported, so the user knows what the archive does and does not hold.

**A missing runtime refuses the delete.** Without a booted harness there is no pool, so no purge is possible, and proceeding would recreate the orphan. Refusing makes deletion unavailable while the harness is down — an accepted cost, because the alternative is a silent permanent leak, and the existing quiescence gate already teaches the user that deletion waits for a settled workspace.

**A conversation hard-delete ships, and only it is gated on a running turn.** `purgeThread` gives the product a verb the archive cannot undo, so the two conversation commands are separated by more than wording: Remove archives and Restore reverses it, while Delete erases and spends the danger ritual. The quiescence gate follows the same split. `appendTurn` writes `messages` with no foreign key to the thread row and tolerates that row being absent — a deliberate design, so a turn never fails over its metadata — which means a turn committing after a purge lands rows attributable to no analysis and reachable by no reclamation. That is a permanent loss, so Delete refuses while a turn is streaming. An archive costs nothing of the kind: the turn's messages land on a tombstoned row and Restore brings the thread back with them, so Remove is deliberately left ungated rather than made uniformly cautious.

The gate is the chat's own activity state, not the analysis-wide busy check the analysis delete uses. A running data profile or workflow writes nothing into `messages`, so refusing a conversation delete for one would block the user over state that cannot be harmed; and the check is already thread-scoped, because the flow only ever purges the open conversation.

**Restore is a separate command, not a toggle in the switcher.** `SelectDialog` composes `FixedList`, whose items are fixed for the dialog's lifetime, so a toggle key inside the open picker cannot re-render the list. Rebuilding the picker on `DynamicList` would be design-system work for a rare action. A distinct palette entry costs nothing, is discoverable by search, and matches how every other deliberate action is reached.

**The restore picker walks the whole listing.** The store widens the set rather than switching to an archived-only one — the right call, since a caller can narrow a widened set but cannot widen a narrowed one — so the archived rows come back among the live ones, ordered by activity. Archiving deliberately leaves `updated_at` alone, so every archived row sorts behind every live one used since; on an analysis with more conversations than a page holds, one page can contain no archived rows at all and the picker's empty state would then state outright that nothing was ever removed. So the picker pages until the set is exhausted, and where it cannot — a failed page, or a walk that outruns its bound — it says so rather than presenting a partial set as complete. A rare, deliberate action can afford the round trips; being told nothing was archived when something was is not a cost it can afford.

**Signing before writing.** The export currently writes the document and then signs it, so a signing failure leaves an unsigned file on disk under a notice claiming the opposite. Building the sidecar first and writing both only on success makes the claim true. Routing the delete flow through this path is what forces the issue: a rare inconsistency becomes a routine one.

**Prune meets the purge's quiescence precondition differently from the delete, and deliberately.** `purgeAnalysis` states that a caller quiesces the analysis first — a run started after the id capture is unreachable afterwards — and the analysis delete enforces that with the workspace busy gate, which reads the analysis's active runs. Prune enforces no equivalent, because it cannot: it boots no harness runtime, so it has nothing in-process to observe, and the only evidence it holds is its own selection criterion. That criterion is what stands in for the check: an anchor is pruned only when its folder is confirmed gone, and every run of its analyses reads and writes beneath that folder. Work cannot both be in flight and have nowhere to write.

The residue is a run belonging to a dead anchor's analysis that some *other* process launched and has not yet failed. Prune's purge cancels it, so the window is the interval between the id capture and the cancel, and the loss is that run's ledger rows rather than any user artifact — the artifacts were already gone with the folder. Closing it properly would mean prune taking the per-analysis instance lock for every analysis it touches, which is a larger change than the exposure justifies. Recorded here rather than left to look covered.

**The reclaim stage is skipped when no analysis is involved, and the containers it starts stay up.** The provisioning gate starts the container stack, so running it for a dead anchor that held no analyses would charge the user a container start — and a running database they did not have before — for a prune with nothing to reclaim. The gate is therefore reached only once at least one analysis id is in hand. When it is reached, the stack is left running afterwards and the command says so: prune owns the pool it opened, not the stack, and a maintenance command that tears down containers the user may be relying on would be worse than one that names what it left behind.

## Risks / Trade-offs

- **Deletion is unavailable when the harness is down** → Accepted, and stated in the refusal. The user is told why and what to do, rather than getting a delete that quietly leaks.
- **The purge is not atomic with the workspace disposal** → It cannot be; they are different stores. The ladder is ordered so that the non-atomic middle is the idempotent stage, and the irreversible identity delete is last.
- **A retry after a mid-ladder failure reports the disposal as `absent`** → Cosmetically odd, factually correct, and already a supported outcome. Better than making the disposal non-idempotent to improve one notice.
- **Exporting provenance on a branch the user may not care about costs a flush and a signature** → Bounded, once per deletion, on an action already doing filesystem and database work.
- **The dialog's new copy is longer** → It has to be: the previous copy was short because it described less than the flow did.
- **Prune cannot prove an analysis is quiesced before purging it** → Accepted, bounded by the dead-folder criterion and the purge's own cancel; the exposure is ledger rows for a run whose artifacts were already lost with the folder. See the decision above.
- **`inflexa prune` can leave a container stack running that was not running before** → Accepted and reported in the command's output, with the command that stops it. Stopping containers the user may be depending on is not a prune's call to make.
