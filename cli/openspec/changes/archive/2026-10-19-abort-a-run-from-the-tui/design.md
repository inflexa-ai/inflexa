# Design

## Context

The cancel path exists from end to end below the TUI:

- `createRunCanceler` in the harness cancels the parent and the children. Then it settles the run row, the step rows, the charge, and the mandate. The harness change of the same name adds the settle of the `running` step rows.
- `POST {A}/run/:runId/cancel` (`src/server/routes/runs.ts`) calls the canceler and gives `CancelRunResult`. An unknown run, or a run of a different analysis, gets 404.
- `cancelRun(analysisId, runId)` (`src/client/runs.ts`) gives `ResultAsync<CancelRunResult, ClientError>`.

The activity panel state is in `src/tui/hooks/activity_panel.ts`. `focusedSubject()` resolves the focus preference against `activeSubjects()` of `sidebar_live.ts`. Thus the focused subject can change under an open dialog when a run ends. The panel chords are in the `MODE_BASE` layer of `app.tsx`, which a dialog suspends. `watchRunCompletions` (`src/tui/hooks/run_completion.ts`) announces each run that it saw active and then sees terminal. `refreshSidebarData(analysisId)` reads the runs at once.

The issue lists the options A, B, C, and D. The archived harness change `2026-10-05-add-run-canceler` built option A, and its canceler closes the charge and revokes the mandate. Those two skipped writes were the reason of the issue to prefer option C. Thus this change uses the canceler as it is, and it does not change the workflow body.

## Goals / Non-Goals

**Goals:**

- A user can abort the run that the panel shows, with one confirmation.
- The report gives the real outcome: canceled, already finished, or failed.
- No surface shows a key that does not answer.

**Non-Goals:**

- An abort of a data profile. No canceler exists for the profile workflow.
- An abort from the sidebar, the runs dialog, or the palette. The issue places the affordance on the panel.
- A cooperative cancel inside the workflow body (option C).
- A provenance record of the end of a canceled run. The canceler emits none today. The coordinator records this as a deferred finding.

## Decisions

**The chord is `<leader> c`, with a remappable final stroke.** `KEYBIND_DEFAULTS` gets `"app.activity-panel-abort": "c"`, and the binding uses `leaderKeybind("app.activity-panel-abort")`. This is the pattern of `session.open-parent`. A leader sequence is two strokes, which suits a destructive action, and `c` is free among the leader keys.

A direct ctrl chord was rejected: the free ctrl letters conflict with terminal conventions (`ctrl+s`, `ctrl+q`, `ctrl+z`, `ctrl+d`), and `ctrl+c` already aborts a chat turn. The label comes from `sequenceLabel(leaderKeybind(...))`, thus a remap changes the legend.

**A layer of its own, gated on a run that shows.** The binding goes in a separate `useBindings` layer in `app.tsx` with `mode: MODE_BASE`. Its `enabled` is `activityPanelVisible() && focusedSubject()?.kind === "run"`.

A disabled layer is absent from which-key and from dispatch. Thus the binding does nothing for a profile or a hidden panel, and the which-key overlay lists it only where it acts. `MODE_BASE` suspends it while the confirmation is open. It has `desc` and `group: "View"`, like the other panel keys.

**The abort logic lives beside the panel state.** `src/tui/hooks/activity_panel.ts` gets `abortFocusedRun(analysisId, opts)` and a `RunAbortOpts` type:

- `confirm(run, onAnswer)`: open the confirmation.
- `cancel(analysisId, runId)`: the client call.
- `refresh(analysisId)`: read the runs again.
- `notify(notice)`: show a notice.

`app.tsx` builds the opts. Its `confirm` pushes `ConfirmDialog` with `dialogPush`, because `activity_panel.ts` has no JSX. The other three members have default realizations in `activity_panel.ts` (`cancelRun`, `refreshSidebarData`, `notify`). This obeys the rule against a separate file for a single-caller helper, and a test can drive each outcome offline. The farm heal hook (`src/tui/hooks/farm_heal.tsx`) uses the same injection pattern.

**The run is captured when the action starts.** `app.tsx` passes `workspace.analysis?.id`, and `abortFocusedRun` returns when no analysis is open. It reads `focusedSubject()` one time. If the subject is not a run, the function returns. Otherwise it keeps the `runId` and the name, and the confirmation and the cancel use only those values. Thus a panel advance during the confirmation cannot move the abort to a different run.

**The confirmation.** `ConfirmDialog` with `tone="danger"`, the default active choice `cancel`, and `cancelLabel="keep running"`. The plain word "cancel" is ambiguous in a dialog about a cancel.

The title is `Abort run`. The message names the run and says that its steps stop and that the run cannot resume. A canceled run is terminal, and the canceler does not resume runs.

**The outcome report.**

- `ok` with `outcome: "canceled"` and `finalStatus: "canceled"`: call `refresh(analysisId)`. The completion watcher saw the run active, thus it announces "was canceled" after the refresh, and the panel advances. When each `converged` flag is true, show no notice, because a second notice would say the same thing two times.
- The same result with a `converged` flag that is false: also show a `warning` notice that names each ledger that did not settle (`steps` as the step rows, `charge`, `mandate`). The canceler logs the cause. A second cancel gives `already_terminal`, thus no retry from the TUI can settle the ledger.
- After that refresh, if the loaded runs snapshot does not hold the run, the watcher cannot announce it. The snapshot holds the active runs and the newest `RUNS_LIMIT` runs, thus an older run drops out when it ends. Then show an `info` notice that the run was canceled, with `queue: true`. The abort also marks the run as announced in the dedup state of the completion watcher (`src/tui/hooks/run_completion.ts`). A failed refresh can hide a run that the next poll shows terminal, and the mark stops a second notice for it.
- `ok` with `outcome: "canceled"` and a `finalStatus` that is not terminal (`running`): the canceler stopped the workflow, but its write of the run row failed and the re-read gave the old status. Show an `error` notice that the run row did not settle, then call `refresh`.
- `ok` with `outcome: "already_terminal"`, or with `outcome: "canceled"` and a terminal `finalStatus` that is not `canceled`: show an `info` notice that the run already finished, with the status. Then call `refresh`.
- `err`: show an `error` notice with `describeClientError(error)`. Then call `refresh`. The canceler can reject after the engine cancel, for example when its final read of the run fails, and a transport failure leaves the outcome unknown. Thus only a fresh read gives the real status.

**A pending guard.** A module-level `Set` holds the `runId` of each open cancel request. `abortFocusedRun` does nothing for a run whose request is open, and it does not block the abort of a different run. The entry of a run goes when its request settles, on each branch.

**The legend.** `ActivityPanelProps` gets a required `abortKeyLabel`, the same as the two other labels. `fitPanelLegend` gets the label and the subject kind. For a run, the chord part of the top rung is `next · hide · abort` with more than one subject, and `hide · abort` with one. For a profile, the rung does not change. The ladder still sheds the full chord part first. Thus the region name and the position survive on a narrow panel.

**The `RunBlock` footer goes.** The `hint` prop and the footer line go from `run_block.tsx`. The `hint={false}` attributes go from the sidebar, the run detail dialog, and the gallery. The gallery exhibit at the top then shows no footer. To connect the footer to the abort was rejected: `RunBlock` is not the surface of the abort, and `esc` and `ctrl+c` belong to other owners.

## Risks / Trade-offs

- [The poll can see the run terminal before the abort response arrives] → The completion notice can then come before the refresh. The abort shows no notice on success, thus the user sees exactly one notice.
- [On the already-finished path, the completion notice of the poll and the "already finished" notice can both show] → This overlap is accepted. The second notice answers the action of the user, and it says why nothing was aborted.
- [A different client can cancel the run while the confirmation is open] → The canceler gives `already_terminal` with `canceled`. The TUI reports that the run already finished (canceled), which is true.
- [The legend is longer for a run] → The ladder sheds the chord part first, and the render tests sweep the widths.
