## Context

The panel takes `progress: ActiveRunProgress | undefined` and renders three things from it: a header (name, `done/total`, elapsed), a frontier row per running step, and one activity line. Its subject is assembled in `refreshSidebarData` from `cortex_runs` and `cortex_step_executions`, keyed by run id, and carried forward with a `stale` flag when a run's step read blips.

A data profile has none of that. It writes no run row and no step-execution row — `insertRun` has two callers (the harness's `execute_plan` tool and the CLI's `inflexa run`) and `insertStepExecution` two (the analysis scheduler and the sandbox-step body), and the profile workflow is none of them. It also has no step decomposition to report at all: it is one agent loop inside one workflow body. So `done`, `total`, and `steps` have nothing honest to hold, and the only durable trace of a live profile is its `cortex_analysis_state` row.

The harness change `data-profile-event-stream` supplies the two things that were missing: the profile emits typed activity across its whole lifecycle, and its ledger row records the workflow id producing those parts. The CLI already reads that row every five seconds, so the subscription key arrives through a read that is already happening.

One constraint is worth stating because it shapes D3: a profile is not always something the user asked for. `ensureProfileAtParity` fires on chat open whenever the input set has drifted, so a profile can appear in the panel's set without any deliberate action.

## Goals / Non-Goals

**Goals:**

- A running profile reports what it is doing, in the surface that already answers that question.
- The profile renders what is true of it and nothing that is not — no invented counts, no empty frontier.
- A profile never displaces a run the user launched.
- The subscription mechanism is the run path's, unchanged in shape.
- A blip in the profile read degrades the panel entry rather than removing it, exactly as a run's does.

**Non-Goals:**

- Changing what the sidebar rail shows for a profile. The rail's one-line `profiling…` is correct at rail width; this change adds a surface, it does not move one.
- A completion notice for profiles. This is a real gap, not a covered case: the parity machinery announces a profile's *start* (`Profiling "…" data…`) and nothing announces its finish, whereas a run announces both. Extending it belongs to the `run-completion-notice` capability, which owns the announce-and-dedup discipline and would need its own delta; riding it in here would put two capabilities' requirements in one change for a surface the request did not name. The ask was the sticky bar, and that is what this delivers.
- Per-step attribution for profiles. There are no steps.
- Fixing the staging/run collision noted in `profile_trigger.ts`. Making a profile and a run visible at once makes that hazard *observable*, but it does not create it and the fix is a run-liveness gate in the parity path.

## Decisions

### D1 — A discriminated subject, not a widened run

**Decision.** The panel's subject becomes `{ kind: "run"; … } | { kind: "profile"; … }`. The run arm keeps `ActiveRunProgress` verbatim. The profile arm carries only what a profile has: an identity, its start time, the stream id to subscribe to, and `stale`.

**The profile's display name is `Data profile`, fixed rather than derived.** A run's name is its plan's title, so it varies and has to be read; a profile has nothing analogous — there is one profile per analysis and it is always the same operation. `Data profile` matches the sidebar's `DATA PROFILE` section label, so the panel and the rail name the same work identically. Rejected: the analysis name (already in the status bar, so it would repeat rather than identify) and a file count (a live figure the profile does not report per-file, and the panel deliberately shows no counts for a profile). Because the name is a constant, it is not carried on the subject at all — it is the render's, which is what keeps the subject to facts the ledger supplies.

**Why not optional fields on `ActiveRunProgress`.** Making `done`/`total`/`steps` optional pushes a guard into every consumer and leaves "a profile with three running steps" representable. The union makes the profile's absence of steps a fact the compiler holds, which is what stops the render from ever reaching for a count that does not exist.

**Why not synthesize a one-step run.** `total: 1` would put a completion meter on screen for work that has no steps to complete. The panel's whole credibility is that its numbers are the ledger's; a fabricated denominator is worse than no denominator.

### D2 — The refresh stays the single writer; the subject set is derived

**Decision.** `refreshSidebarData` writes two cells: `activeRunProgress` unchanged, and a new profile-progress cell built from the profile snapshot with the *same* carry-forward-and-mark-stale treatment the run map already gets. The ordered subject set the panel consumes is a memo over the two.

**Why the carry-forward has to be in the refresh.** A pure memo over `profileSnapshot` has no memory, and that snapshot collapses to `unavailable` on any `DbError`. So a transient blip would drop the profile subject entirely — the panel entry would vanish and return, which the panel's own degradation requirement forbids ("SHALL NOT remove the panel, blank it, or present a run as finished"). Carry-forward needs the previous value, and the only place holding it is the setter.

**Why not a second writer.** The module's existing discipline is explicit that the refresh owns ordering, plan resolution, and staleness, and that anything else is a trigger rather than a data source. A second writer for the profile cell would need its own generation-token story for no gain.

**Only a `running` profile is published, not a `pending` one.** `data_profile_started_at` is written by the transitions *into* `running`, so a `pending` row has none — a pending subject would have no start time to render an elapsed from, and no workflow id, and nothing reported. It would be a name and two blanks. More to the point, `pending` means seeded-and-queued, and the panel answers what is *happening*; work that has not begun has nothing to say. The poll's arming condition still counts a pending profile as active work, which is correct and untouched — that governs whether to keep looking, not whether to show anything.

**Consequence.** The rail is untouched. It keeps reading `activeRunProgress`, so nothing about the RUNS section changes, and the subject set exists only for the panel.

### D3 — Profiles sort after every run

**Decision.** The subject set is ordered runs-first (in the existing newest-first run order), then the profile.

**Why order by kind and not by time.** Every other ordering in this module is recency, so departing from it needs a reason: the two subjects differ in **provenance**, not in recency. A parity profile is triggered by opening a chat, not by the user asking for anything, so a newest-first set would routinely let it take position 1 and push a deliberately-launched run off the panel. Ordering by kind makes the background thing reachable without ever making it the thing on screen.

**Rejected — show only deliberate profiles.** The ledger records no trigger origin, so this needs a new column threaded through both the parity and force entry points, to end up with a *narrower* surface. The silent wait is the problem; hiding the common case does not solve it.

**Rejected — a separate stacked region for the profile.** It costs a row whenever a profile runs, and it splits one question ("what is happening") across two surfaces the reader has to check independently. Navigation already exists; reusing it is cheaper for the reader than a second region.

### D4 — The subscription keys on a stream id

**Decision.** One memo resolves the focused subject's stream id — the run id for a run, the recorded workflow id for a profile — and the existing subscription effect keys on that.

**Why this is the whole payoff of the harness decision.** Both values are exactly what `createRunEventStream(...).subscribe({ runId })` takes, so the effect's shape does not change: one open stream for the focused subject, torn down on focus change, on termination, and on unmount through the same abort. Had the CLI been left to derive a profile's workflow id, this seam would have needed a second code path.

**A profile with no recorded id yet** resolves to no stream id, so no subscription opens and the subject renders with no activity line. That is the same state the panel already renders for a run that has reported nothing, and the harness spec states it is a normal condition rather than an error.

**Re-subscription on a re-profile falls out for free.** A new attempt records a new workflow id, the memo's value changes, and the effect re-runs. This is the same reason the run path keys on `focusedRunId` rather than on the run object: narrowing to the id is what lets referential equality stop a five-second poll from re-opening the stream.

### D5 — The activity fold stops filtering by the part's `runId`

**Decision.** Drop the `part.runId !== runId` guard in the activity fold.

**Why it must go.** The harness contract states a profile's parts carry the constant literal `"data-profile"` as `runId` — the same string for every analysis — and states normatively that consumers must not key on it. A filter comparing it against the focused subject's id would discard every profile activity.

**Why removing it costs nothing.** The guard is already redundant. The subscription is scoped to one workflow and its children, so every delivered part belongs to the focused subject by construction. The guards that actually do work are untouched: the generation token, which makes a late part from an abandoned subscription harmless, and clearing the activity map when focus moves, which is what stops one subject's phrase appearing under another's name.

**The redundancy is asserted here, so it is tested there.** Dropping a guard on the strength of an invariant obliges the change to pin the invariant: a test drives one subject's subscription, delivers a part carrying a *different* subject's identifier, and asserts the panel still shows it — which is the behaviour the removal produces, and which would silently revert to filtering if someone re-added the check. Without that test the guard's absence looks like an oversight to the next reader and gets restored, breaking profiles.

### D6 — The legend's region name comes from the subject

**Decision.** `fitRunLegend` becomes `fitPanelLegend` and takes the region name; the panel supplies `"RUN"` or `"PROFILE"` from the focused subject. The ladder's structure — shed chords, then shed the position, then the bare region name — is unchanged.

**The rename is required, not cosmetic.** The function's whole output for a focused profile is a legend reading `PROFILE`, so a name asserting it fits a *run* legend would be actively false at the call site — the kind of stale name that survives because nothing type-checks it. Renaming an exported, tested function is a real cost, and it is paid here because leaving it is the more expensive option.

**Why the existing boundary tests survive.** A run's region string is still `"RUN"`, so every measured width for the run case is unchanged and the pinned boundary columns stay valid. `PROFILE` is four characters longer, so a profile's full legend first fits at a wider panel — which means the profile case needs its **own** measured boundary rather than an assumed one, because the whole point of the ladder is that opentui drops an over-long title silently instead of truncating it.

### D7 — The profile's marker matches the rail, not the run

**Decision.** A profile subject's header marker is the warning glyph in the warning role — the same pair the rail's running-profile line uses.

**Why.** One piece of work should look like itself across the two surfaces that show it. Borrowing the run's own marker instead would make a profile look like a run in the one place they sit side by side, which is precisely where the distinction matters. Reusing the rail's pair also means no new foreground/background combination enters the contrast matrix — which is a claim to verify against the matrix rather than assume, since the panel paints the raised surface and the rail does too.

## Risks / Trade-offs

- **Two cells plus a memo where there was one map** → contained: one writer, identical carry-forward discipline on both cells, and the memo is pure ordering with no state of its own.
- **The `next` chord now cycles a set the user did not fully populate** → intended, and the legend's position indicator is what keeps it legible. A profile appearing as `2/2` is information; a profile appearing silently would not be.
- **Dismissal now hides a profile too** → correct under the dismissal's existing scope: it means "not this, not now" and clears once nothing is active, so a later profile brings the panel back.
- **A profile and a run visible together makes the staging collision observable** → the hazard already exists (`stageInputs` can relink the shared input tree while a sandbox step reads it); this change neither creates nor fixes it, and surfacing it is closer to a benefit than a cost.
- **`PROFILE` needs a wider panel than `RUN` for its full legend** → handled by the ladder, but only if the profile case is measured rather than inferred. Called out as its own test.

## Migration Plan

No persisted state changes on this side. The prerequisite is the harness change: `DataProfileStatus.workflowId` must exist and the local harness must be built and linked, because the published version the CLI pins does not carry it. Without that field the subject renders but never subscribes — a degraded state, not a broken one, which makes the two halves independently landable in that order.

Rollback is a straight revert; nothing outlives the process.

## Open Questions

None. One that looked open is settled by the contract: the panel renders the harness's `activity` phrase verbatim and uses `phase` only to decide whether a step has settled, so the `indexing` phase needs no rendering decision here — whatever phrase the producer emits for it is what shows.
