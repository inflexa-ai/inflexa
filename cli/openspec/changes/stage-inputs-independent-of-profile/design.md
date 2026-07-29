## Context

`ensureProfileAtParity` (`src/modules/harness/profile_trigger.ts`) is a ladder of cheap-gate-first checks that ends in `stageAndSeed` → `trigger`. Staging lives at the bottom, so every early return above it also suppresses materialization. That was harmless while `inflexa profile` was the only way to add inputs — the command staged unconditionally. The `chat-input-staging` change made input registration a mid-session, register-only mutation and delegated materialization to this ladder, at which point every early return became a way to lose the user's files.

Three constraints shape the fix:

- **`stageInputs` is a destructive tree operation.** It rm/relinks under `data/inputs/local` and then deletes every on-disk file absent from its own manifest (`reconcileStagedTree`). Two concurrent stagers on one analysis corrupt each other, which is why `serializeProfileWork` (`src/tui/hooks/profile_parity.ts`) funnels every entry into the profile lifecycle through a single queue. Any new staging trigger must join that queue rather than open a second door.
- **Staging is expensive; the drift check is not.** `stageInputs` pays SHA-256 over genomics-sized files, while `enumerateInputSignatures` costs stat/readdir. The current ladder's ordering exists to keep a no-drift chat open off the hashing path, and that property must survive.
- **No-litter (`data-profile-launch`).** Staging and runtime boot happen only on deliberate flows. Opening an analysis, editing its inputs, and the profile/run commands qualify; a passive read does not.

## Goals / Non-Goals

**Goals:**

- A registered input is materialized regardless of the data-profile ledger's state, except while a profile is actively running.
- A profile failure that predates the current input set stops being a permanent block on both staging and profiling.
- The steady-state path (open a chat, nothing changed) still costs stat/readdir, with no content hashing.

**Non-Goals:**

- Auto-retrying a profile that failed against the *current* input set. That stays a deliberate act; the loop-prevention rationale is untouched.
- Fixing why profiles fail. The companion harness change (`data-profile-failure-diagnostics`) covers the unreadable error; this change assumes failures happen and must not wedge the session.
- Closing `TODO(robustness)` at `profile_trigger.ts:136` (restaging under a live `executeAnalysis` run). Out of scope, and the retained `already_running` skip is aligned with eventually fixing it.
- Changing the agent-facing `manage_inputs` result. Once drift reliably re-profiles (Decision 3), a registered input always changes the signature set and therefore always materializes and re-profiles, so there is no non-advancing state left for the tool to warn about on this path. Reading a failed row at any *other* time is covered by the companion harness change's staleness signal.
- Changing what a profile *is*, the ledger CAS transitions, or the harness trigger contract.

## Decisions

### 1. Staging moves up inside the existing drive, not into the mutation path

Hoist materialization above the profile-status gates in `ensureProfileAtParity`, keeping it inside the single serialized drive.

*Alternative — stage in `manage_inputs`/`addInputs` at registration.* Rejected: `analysis-input-management` states "Input mutation SHALL be register-only: it SHALL NOT stage files into the workspace tree and SHALL NOT boot a harness runtime", and the terminal `inputs add`/`remove` subcommands run with no booted runtime at all, so staging there would both break that requirement and violate no-litter for the terminal surface. It would also miss the boot/swap edge, where a previously-wedged analysis needs to heal on open.

*Alternative — a separate materialization edge in the watcher.* Rejected: it introduces a second writer to a tree whose safety rests on there being exactly one. Sharing `serializeProfileWork` to make it safe collapses it back into this decision with extra indirection.

### 2. The staged tree is its own record; no new persisted artifact

"Is this input set already materialized?" is answered by comparing the enumerated source signatures against a `stat` of each expected staged path. No marker file, no serialization format, no parse step, and no record-versus-tree desync class — the thing being described *is* the record.

This works because `stageInputs` prefers `linkSync`, and a hardlink shares the source inode, so a staged file's size and mtime equal the source's by construction. The cross-filesystem `copyFileSync` fallback breaks that: measured, a copy's mtime is its copy time, not the source's. Left alone, every copy-mode analysis would read as permanently unmaterialized and re-hash on every check. So the copy branch stamps the source's mtime onto the destination.

That stamp must never be applied to the hardlink branch. Measured: `utimesSync` on a hardlink rewrites the shared inode, which would mutate the *user's own input file* and — because `enumerateInputSignatures` reads the source's mtime — manufacture permanent phantom drift. The stamp belongs inside the copy fallback only, and the reason is non-obvious enough to state at the call site.

*Alternative — a `.staged.json` marker at the data root.* Rejected: it adds a persisted file, a format, an atomicity question, and a whole class of record-versus-tree disagreement, to answer a question the tree already answers. It would also publish a layout path, which the repo guidance treats as making an installer detail into an interface.

*Alternative — a column in the harness ledger.* Rejected: a cli-local staging concern must not drive a schema change in the harness, which is the product core and host-agnostic by design.

*Alternative — a row in the cli's SQLite.* Rejected: the cli's own doctrine is that the database and the filesystem routinely disagree. Storing "what is on disk" anywhere but on that disk maximizes exactly that failure mode.

Per the desync rule the predicate is conservative in one direction only: any missing file, size mismatch, mtime mismatch, or unexpected extra file under `inputs/local` reads as not-materialized and stages. It can cost a redundant staging pass; it cannot produce a false "already materialized".

### 3. Drift re-profiles regardless of the prior outcome

Remove the `failed` special case from the drift rule rather than adding a second exception to it. If the current signature set differs from what is materialized — the set the last attempt was staged for — claim `failed → running` and run, exactly as `forceReprofile` already does. If they match, return `skipped_failed` unchanged.

The anti-loop guarantee survives by construction: a retry is reachable only through a fresh user edit, so an endlessly-failing profile cannot spin on its own. What changes is that `failed` stops being the one ledger state where drift means nothing.

This is a simplification of the ladder, not an addition to it. It also restores `analysis-input-management`'s "drift SHALL re-profile" promise, which the current blanket skip silently falsifies.

*Alternative — retry any `failed` row on every parity check.* Rejected: a deterministic failure (bad credential, unreachable proxy) would re-run on every chat open, burning a sandbox each time.

*Alternative — leave profiling alone and only fix staging.* Rejected as insufficient, and as the more complex outcome: the files would land while the ledger stayed permanently wrong, requiring the agent to be separately taught that a `failed` row may not be about its inputs. Fixing the ledger removes the need for that compensation.

### 4. `already_running` keeps suppressing staging; the completion edge widens

A live sandbox is reading the tree `stageInputs` would reconcile-delete. The skip stays. To stop the deferred work being lost, parity edge 3 fires on `running → failed` as well as `running → completed` (`profile_parity.ts:209`), so a run that dies still releases the pending materialization.

### 5. The outcome union separates the staging fact from the profile decision

`ProfileParityOutcome.kind` keeps its current meaning — what happened to the *profile* — and gains an orthogonal `staged: boolean`. Adding kinds for each staging×profile combination would multiply the union and every consumer's switch for no gain, and the two facts are genuinely independent now. Both drivers switch on `kind` alone, so the addition is non-breaking for them.

A staging failure is reported as the existing `failed` outcome with its reason, and the profile decision is not reached — staging is a precondition for seeding, so there is nothing coherent to decide once it fails.

### 6. Deliberate commands keep staging unconditionally

`inflexa profile` and `inflexa run` do not consult the predicate. They are deliberate acts where re-materializing is defensible, and leaving them unconditional preserves them as the repair path for a tree the predicate misjudges. This also keeps the predicate on exactly one call path, which is the one that needed it.

## Risks / Trade-offs

- **Copy-mode staging now writes mtimes** → Confined to the copy fallback, applied only to a destination this code just created, and required for the predicate to work at all in that mode. The hardlink branch is untouched, which is where the danger was.
- **A hand-edited staged tree reads as unmaterialized** → Correct behavior: it stages and the mirror pass repairs the tree. The predicate's only failure mode is a redundant hash pass.
- **The predicate walks `inputs/local` to spot extra files** → readdir-cost, the same order as `enumerateInputSignatures`, which the ladder already runs on every check.
- **Drift-scoped retry burns a sandbox per user edit on a persistently broken setup** → Bounded by user action, and each retry now produces a readable error via the companion harness change. Materially better than the current outcome, where the same user gets no profile and no files.
- **Widening the completion edge to `running → failed` could re-check more often** → The transition is already observed by the sidebar poll; no new polling, and the drive short-circuits on the predicate when nothing drifted.
- **A test that pins current behavior must be rewritten, not extended** → `profile_trigger.test.ts:261` asserts `{stage:false, seed:false, trigger:false}` for a failed row. Rewriting it is the point of the change; leaving it green would mean the fix did not land.
- **Cross-process staging of one analysis** → Unchanged by this design: the per-analysis instance lock remains the only cross-process exclusion, and the predicate introduces no shared mutable state of its own.

## Migration Plan

No data migration and no new on-disk state. Existing analyses staged through the copy fallback carry copy-time mtimes, so their first check reads as unmaterialized and stages once, which rewrites those mtimes to the source's — self-healing, and exactly what a wedged analysis needs. Hardlink-staged analyses (the common case) already satisfy the predicate and stage nothing. Rollback is a code revert; the mtime stamp left on previously copied files is inert to the prior code.
