## Why

The sticky panel answers one question — *what is happening right now* — and it answers it for exactly one kind of work. A data profile is the other long-running thing a user waits on, and while it runs the panel shows nothing at all. The rail says `profiling…` on one line and the wait is otherwise silent, which is the same complaint that made the run path's activity readout worth building: knowing that something is running is not knowing what it is doing.

The harness change `data-profile-event-stream` supplies the missing half. A profile now emits typed activity across its whole lifecycle — including the container-provisioning stretch that precedes its agent loop — and its ledger row names the workflow producing those parts. The profiler's tools are the ones the existing translator maps best, so the phrases arriving are the ones a reader wants (`Running script profile.py`, `Reading file counts.csv`) with no new vocabulary on this side.

What blocks it here is that the panel's data model is run-shaped. Its subject is `ActiveRunProgress` — `{runId, name, tag, startedAt, done, total, steps[], stale}` — assembled exclusively from `cortex_runs` and `cortex_step_executions`. A profile writes neither row, and it has no step decomposition to report, so three of those fields have nothing honest to hold. Synthesizing a fake run to fit the shape would put invented counts on screen; the panel needs a subject that can be a profile.

## What Changes

- The panel's subject becomes a discriminated union of *run* and *profile*, so a profile renders what is true of it — its name, its elapsed time, and its activity — and renders no completion count and no frontier rows, because it has neither.
- `sidebar-live` publishes an active-**subject** set in place of its active-run map. A running or pending profile joins the set, ordered **after** every active run, so a background profile is reachable but never displaces a run the user launched.
- The panel's legend takes its region name from the focused subject (`PROFILE`, `RUN 2/3`) rather than hardcoding `RUN`. The width ladder is unchanged in shape; only the region string varies.
- The activity subscription keys on the focused subject's **stream id** — a run's id for a run, the recorded workflow id for a profile — which is the one value the harness read seam takes either way.
- A profile subject is carried forward across a failed ledger read and marked stale, the way a run already is. Without this a transient blip would make the panel entry vanish and return, which the panel's own degradation requirement forbids.
- The design gallery gains profile-subject exhibits, so the new subject kind is showcased rather than invented off to the side.

## Capabilities

### New Capabilities

None. The panel and the live store are both existing capabilities, and this widens what each admits rather than introducing a new one. Minting a `panel-subjects` capability would split one surface's requirements across two specs and leave neither able to state the panel's behaviour on its own.

### Modified Capabilities

- `run-activity-panel`: the panel's subject is no longer necessarily a run. The frontier requirement is widened to cover a subject that has no steps and no counts, and the legend requirement's region name becomes subject-derived.
- `sidebar-live`: the store's live-progress publication becomes an ordered subject set that includes the data profile, with the same carry-forward-and-mark-stale discipline the active-run map already has.

## Impact

- `src/tui/hooks/sidebar_live.ts` — the subject type, the merged and ordered subject set, and the profile's carry-forward.
- `src/tui/hooks/run_panel.ts` — focus, position, and count over subjects; the subscription keyed on the stream id; the activity fold no longer filtering by a part's `runId` (which is a constant for a profile, by the harness's stated contract).
- `src/tui/layout/run_activity_panel.tsx` — the subject union in props, the counts-and-frontier rows becoming run-only, and `fitRunLegend` taking a region.
- `src/tui/layout/design_gallery.tsx` + `design_gallery_fixtures.ts` — profile-subject exhibits.
- `src/tui/layout/run_activity_panel.render.test.tsx`, `src/tui/app_run_panel.render.test.tsx` — the subject shape and the legend ladder's new region cases.
- **Hard prerequisite**: this cannot be implemented against the published `@inflexa-ai/harness` version the CLI pins. It needs `DataProfileStatus.workflowId` from the harness change, so that change must land and be linked locally first — the same precondition the previous run-observability work carried.
- **Spec-text precondition**: the requirement this change modifies (`A sticky panel shows the focused run's frontier`) currently lives as an unarchived delta in `run-observability-surfaces`, not in `openspec/specs/run-activity-panel/spec.md`. The MODIFIED blocks here are composed against that pending text, so `run-observability-surfaces` must be archived into the spec tree before this change is, or the delta will not apply against the requirement it was written from.
