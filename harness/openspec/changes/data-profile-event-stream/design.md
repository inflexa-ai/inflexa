## Context

`runDataProfileBody` drives the profiler agent through `runToTerminal` with `emit: () => {}`. Every orchestration event the loop produces — `tool-started`, `tool-finished`, model deltas — and every sandbox event `awaitExec` forwards is discarded at the point of production. The workflow therefore has no observable surface at all: the only trace of a live profile is `cortex_analysis_state.data_profile_status = 'running'`.

The run path solved the same problem differently and completely. `sandbox-step.ts` wires a real `emit` that writes typed parts to its own durable `"events"` stream, and `createRunEventStream` reads those streams back as one channel. The translation from a loop event to a rendered phrase already exists and is pure: `activityForTool` maps the profiler's own toolset (`execute_command`, `read_file`, `write_file`) onto the phrases a reader wants. So the producer is the only missing piece — nothing about the contract, the reader, or the vocabulary needs inventing.

A second constraint shapes the whole design. A profile's stream cannot be addressed:

- its `RunFrame.runId` is the constant literal `"data-profile"`, identical for every analysis and every attempt;
- its DBOS workflow id is `dataprofile:{analysisId}:{randomUUID()}`, and the nonce is *deliberately* random — the minting site documents that a stable id would make every re-profile a no-op, because DBOS workflow ids are permanent idempotency keys;
- nothing persists that id: `cortex_analysis_state` has no such column and `DataProfileStatus` has no such field.

So "which stream carries this analysis's profile" has no answer that does not reconstruct an identifier the system already held and threw away.

## Goals / Non-Goals

**Goals:**

- A live profile reports what it is doing, across its whole duration — including the stretch before the agent loop starts.
- A consumer can find a profile's stream from data it already reads, without touching durability-engine tables.
- One construction of a step-activity part, shared by both producers.
- The existing run-event read seam is reused, not widened.

**Non-Goals:**

- Sandbox command output. The sandbox server emits only file-tree deltas as progress; there is no command-output channel to forward, and the run path's spec already records this as out of scope.
- A file tree for the profile. The profiler's scratch tree under `runs/data-profile/` is deleted on completion, so a path list would advertise files that are about to stop existing.
- Giving the profile a real `runId` or a `cortex_runs` row. See D3.
- Deciding how a consumer renders any of this. The phases and phrases are the contract; the surface is the embedder's.

## Decisions

### D1 — The ledger row names the profile's workflow; the id is never derived

**Decision.** Add a nullable `data_profile_workflow_id` to `cortex_analysis_state`, written by the workflow body as its first durable step from `DBOS.workflowID`. Project it as `DataProfileStatus.workflowId`.

**Why the body and not the trigger.** The trigger's claim CAS runs *before* `startDataProfileWorkflow` mints the nonce, and only the attempt that actually started can report its own id. The body reading `DBOS.workflowID` is the single point where the value exists and is known to belong to the live attempt. The consequence is a window — between the CAS flipping the row to `running` and that first step landing — where the row is `running` with a null id. That collapses into a state every consumer must already handle: running, nothing reported yet.

**The write is guarded on `running`, and is best-effort beyond that.** The write carries `AND data_profile_status = 'running'`, which rules out the case that would actually mislead: a late-landing write stamping a row that has already settled, so a consumer subscribes to a workflow for a profile that is finished. What the guard does *not* rule out is two attempts both believing they are the running one, which the stale-expiry path admits — a row whose `data_profile_started_at` has aged past the timeout can be claimed by a second attempt while the first body is still alive but has not yet completed its first step, and that first step then overwrites the second's id.

That residue is deliberately left rather than mechanised, because its worst outcome is already a specified state. A consumer that subscribes to a superseded workflow reads a stream that drains immediately, so it observes no activity — which is exactly "running, nothing reported yet", declared normal above and rendered correctly. The failure mode is a missing activity line for one profile, not a wrong one.

**Rejected — make the claim CAS write the id atomically.** Minting the nonce before the claim and having `tryStartDataProfile` write `data_profile_workflow_id` in the same UPDATE would close the race completely: exactly one CAS wins, so exactly one id is written, and it is the winner's by construction. It is rejected because of how the id would then have to travel. The three claim functions return `Result<boolean>` and callers branch on truthiness (`if (!retried)`); widening a return to carry the id makes every one of those branches always-taken, which is a silent behaviour change in the embedder's recovery path. Threading the nonce inward instead means the CLI mints workflow ids, putting a harness-internal construction into an embedder's hands. Neither cost is worth closing a race whose outcome is an already-normal state.

**Rejected — pattern-match the durability engine's workflow table.** `SELECT workflow_uuid FROM dbos.workflow_status WHERE workflow_uuid LIKE 'dataprofile:' || $1 || ':%' ORDER BY created_at DESC LIMIT 1` works, needs no migration, and could live inside a harness seam so the engine read stays on this side of the package boundary. It is rejected on two counts. First, it makes the workflow-id *string format* load-bearing: `dataProfileWorkflowId` is a private construction whose only obligation today is uniqueness per attempt, and a query that parses it silently promotes that shape to a contract. Second, `ORDER BY created_at DESC LIMIT 1` is a guess — when two triggers race, the ledger CAS decides which attempt owns the row, and the newest workflow row is not guaranteed to be that one.

**Rejected — make the workflow id stable and derive it.** `dataprofile:{analysisId}` would need no column at all. This is precisely what the nonce exists to prevent, and the reason is recorded at the minting site: a stable id is a permanent idempotency key, so every re-profile after the first would dedup against the first terminal run, the body would never re-execute, and the ledger would sit at `running` until it timed out.

**Precedent.** `cortex_target_assessments.workflow_id` records a DBOS workflow id on a ledger row, nullable for the same reason (older rows tolerate NULL; new rows always write it), added by the same additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in the same DDL block.

### D2 — The profile subscribes through the existing reader, unchanged

**Decision.** No change to `createRunEventStream`. A consumer subscribes with the profile's workflow id passed as `runId`.

**Why it already works.** The seam's contract is "deliver every part this workflow and its children produce, resolving when the run is terminal and every stream has drained". A profile is a workflow with **no** children: it never calls `insertStepExecution` (the only callers are the analysis scheduler and the sandbox-step body), so `queryStepsByRun` returns no rows, discovery finds nothing, and the parent stream draining *is* the profile going terminal. That is the seam's existing behaviour applied to a degenerate case, not a new one.

**Cost, accepted.** Child discovery re-reads the step ledger once a second for the profile's duration and always finds nothing — roughly 60–300 indexed queries over a one-to-five-minute profile. That is less than the sidebar poll already running beside it, and it buys the property that a profile needs no special reader.

**Rejected — an option to disable child discovery.** It would have the caller assert something the data already answers, and it adds a configuration axis to a seam that documents having exactly one method on purpose ("a general-purpose stream reader would leak the engine's model back into the surface this exists to quarantine").

**Rejected — renaming the parameter to `workflowId`.** More honest at the call site, but it modifies a capability whose own change has not been archived yet, for no behavioural gain. The parameter's documentation already states it is the parent workflow's id; the profile relies on exactly that reading.

### D3 — The emitted frame is the workflow's existing synthetic one

**Decision.** Emit with `runId: "data-profile"` and `stepId: "profile"` — the literals the workflow already uses for its sandbox identity and its `runs/data-profile/` scratch path. The part id is the shared per-step construction, yielding a constant `step-activity-data-profile-profile`.

**Why not mint a real run id.** The literal is load-bearing in the workspace layout: it appears in the sandbox mount, in `mintSandboxIdentity`, and in the scratch path the post-agent cleanup wipes. Replacing it is a workspace-layout change with a far wider blast radius, and it would buy nothing here — the subscription is scoped to one workflow, so no consumer ever has to disambiguate parts by `runId`.

**Consequence, stated as a contract rather than left to be discovered.** The part's `runId` is a constant, not an identifier: it is the same string for every analysis. A consumer must not filter or key profile activity by it. This is the one place a reader could reasonably carry a run-path habit over and get a wrong answer, so the spec says so explicitly.

**Why a constant part id is safe.** The reconciling fold keys on part `id`, and its scope is one stream. Each attempt has its own workflow id and therefore its own stream, so two attempts can never fold against each other — which is exactly the property the per-attempt nonce guarantees.

### D4 — Five of the contract's ten phases, with pinned phrases

**Decision.** The emissions, in body order, with their exact phrases:

| # | Where | Phase | Phrase |
|-|-|-|-|
| 1 | before `createSandbox` | `sandbox-init` | `Starting sandbox` |
| 2 | before `runToTerminal` | `executing` | `Running data-profiler` |
| 3 | per `tool-started` | `executing` | `activityForTool(name, input)` |
| 4 | the vector-store pass | `indexing` | `Indexing input descriptions for search` |
| 5 | after the terminal ledger write | `complete` | `Profile complete` |
| 6 | the catch | `failed` | the user-safe ledger reason |

The phrases are pinned here because they are the deliverable. This whole change exists so a user can read what a profile is doing, and a phrase left to the implementer is the one part of the work that cannot be checked by a type or inferred from a neighbour. Each follows the sandbox-step body's established vocabulary — imperative gerund plus object (`Describing output files`, `Registering artifacts`, `Indexing outputs for search`, `Step complete`) — so the two producers read as one voice rather than two.

**Why `sandbox-init` matters most.** Container provisioning is the longest single operation in a profile, and it happens *before* the agent loop exists. Emitting only from the loop would reproduce the precise defect the run path just fixed: a readout that only appears once the slow part is over, leaving the silence exactly where the user is waiting. Emission 2 covers the remaining gap, between a ready sandbox and the agent's first tool call, exactly as the run path's `Running ${agentId}` does.

**The five unused phases, enumerated so their absence is a decision.** `generating-metadata` and `generating-summary` describe the sandbox-step's post-agent pipeline, which a profile does not run — its agent delivers everything through `submit_profile`. `persisting` is defined as step bytes uploading to an artifact store, and a profile's durable products are the vector index and the ledger row, so it would describe nothing. `retrying` needs a retry loop, which the profile body does not have — a failure is terminal and recovery is a fresh attempt. `warning` needs a non-fatal warning channel to the user; the profile logs its two soft conditions (an empty manifest, a fallback file description) and neither warrants interrupting the activity line.

**Where `complete` is emitted is load-bearing, not incidental.** It goes *after* the terminal ledger write, not before. Emitted earlier, a ledger write that then threw would fall into the catch and emit `failed` too — two terminal activities for one profile, and a consumer folding latest-wins would land on whichever arrived second. Ordering it after the write makes "exactly one terminal activity" hold by construction. The sandbox teardown in the `finally` emits nothing for the same reason.

**A profile that fails before its sandbox exists** emits `sandbox-init` then `failed`, with no `executing` between them. That is correct and needs no special handling: the terminal phase is what a consumer keys on, not the sequence that preceded it.

### D5 — One helper moves: the part id, and only the part id

**Decision.** `stepPartId` moves from `sandbox-step.ts` (where it is module-private) into `sandbox-step-translate.ts`, and both producers mint their part ids through it. The failure-swallowing stream write is **not** lifted; each body keeps its own five-line version.

**Why the part id must be shared.** It is a *reconciliation contract*, not a convenience: the fold collapses phase transitions latest-wins only if every producer mints the id the same way. Two independent copies of that rule is the kind of divergence that leaves both files' tests green while a reader sees duplicate frames — the same failure mode as the two step-name formatters that made the run panel's old label vocabulary unreachable. One function, no behaviour change, and the run path's emitted ids are byte-identical before and after.

**Why the safe-emit is deliberately not lifted.** It looked like the other half of one construction, but it is not: each body's version closes over that body's own logger binding, so a shared version would have to take both a write function and a logger, at which point the caller supplies everything and the helper saves nothing. Lifting it would also mean editing the shipped sandbox-step emitters for no contract benefit, and this change should touch the run path as little as the shared-id rule strictly requires — that path was delivered days ago and its correctness is not what is being changed here.

`sandbox-step-translate.ts` is the right home by its own description — pure translation, no DBOS, no per-run state, holding "the label mapping ... and the chat-data-part narrowing the `sandbox-step` workflow body composes into its emitters". `stepPartId` is a pure string function, so it lands there without pulling the engine in behind it, which is precisely why it is the half that can move and the safe-emit is not.

### D6 — The ordering discipline is inherited verbatim

`DBOS.writeStream` allocates a function id, so a fire-and-forget write races the next real operation for the counter and desynchronises the recorded sequence on replay. Every emit is therefore awaited in body order. The loop already awaits its `emit`; the body's own emissions (`sandbox-init`, `indexing`, terminal) must too. This is the sandbox-step body's existing rule, adopted as-is rather than restated as a new one — and it is why the profile's already-checkpointed clock and function-id minter are the right precedent to follow here.

## Risks / Trade-offs

- **Adding stream writes changes the body's DBOS function-id sequence** → a profile in flight across the upgrade replays against a sequence that no longer matches. Profiles are bounded (`DEFAULT_DEADLINE_MS` = 300s) and the orphan-reconcile path resets a `running` row with no live workflow, so the exposure is one re-profile for a profile unlucky enough to span the deploy. Not mitigated further — the alternative is versioning the body, which costs far more than the failure. The reconcile claim is what makes the exposure bounded, so it is **tested** here rather than asserted: a wedged `running` row with no live workflow must be recoverable into a fresh profile.
- **The claim → workflow-id-write window leaves a `running` row with a null id** → collapses into "running, nothing reported yet", which every consumer must handle regardless (a profile that has emitted nothing yet is indistinguishable and equally normal).
- **Two attempts can briefly disagree about which owns the recorded id**, via the stale-expiry claim → guarded down to the harmless case in D1 and left there: the worst outcome is a subscription to an already-drained stream, which renders as no activity line rather than a wrong one.
- **One stream row per tool call** → bounded by the profile deadline, and the reconciling fold means readers converge rather than replaying. Identical to a sandbox step's volume, which is already accepted.
- **Child discovery queries for children that cannot exist** → quantified and accepted in D2 rather than designed around.
- **A constant part id across analyses** → safe only because the fold's scope is one stream. Recorded here because it would become unsafe the moment anything folded two attempts' streams together, which is a property worth stating rather than assuming. Pinned by a test that runs two profiles under different workflow ids writing the *identical* part id and asserts each subscriber sees only its own.

## Found out of scope: `subscribe` can resolve with parts still queued

Writing the profile's stream tests surfaced a pre-existing gap in the read seam this change deliberately does not touch. `readWorkflowStream` enqueues with `pending.push(part); void deliver();` — the delivery pump is unawaited — while `settled` awaits only discovery, the parent read, and the child reads. Nothing waits for `pending` to drain, so `subscribe` can resolve while frames are still queued and `deliver()` is suspended inside a slow `onPart`.

With a synchronous handler the drain wins on microtask ordering, which is why the existing tests and the CLI's own subscriber (a signal write) never observe it. It bites exactly the case the seam's own doc invites — "back-pressure is the caller's to exert by taking its time".

Not fixed here, deliberately: this change's D2 turns on the read seam being untouched, and widening its settle semantics is a change to that capability's contract with its own delta to write. Recorded so it is a known defect with a reproduction rather than a surprise for whoever next writes a slow handler.

## Migration Plan

The DDL is additive and idempotent (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), applied on startup inside the existing advisory-lock-serialized `initCortexState` flow — the same mechanism and the same block as every other column in this schema. No backfill: a null id on a row written before this change is the honest value, and reads back as "this profile's stream is not addressable", which is true.

Rollback is asymmetric and deliberately so. Reverting the code leaves the column in place, ignored — nothing reads it, and it costs one nullable TEXT per analysis. Reverting the column while the code still runs would break the body's first step, so the column is the durable half and must land first.

## Open Questions

None blocking. One deliberately left to consumers: whether `indexing` warrants a distinct rendering from `executing`, or reads better folded into one "working" state. The phase is emitted either way; the choice belongs to the surface, not here.
