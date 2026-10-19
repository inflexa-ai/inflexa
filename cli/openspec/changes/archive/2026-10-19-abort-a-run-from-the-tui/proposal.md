# Abort a run from the TUI

## Why

The TUI has no way to abort a run (issue #250). The harness run canceler and the cancel route of the local server exist, but no TUI surface calls them. Also, the gallery exhibit of `RunBlock` shows the footer `esc detach · ctrl+c abort`. No surface answers these keys for a run, and `ctrl+c` aborts a chat turn.

## What Changes

- The activity panel gets an abort action for the run that it shows. The chord is `<leader> c` (`ctrl+x c` by default), with a remappable final stroke. The binding is live only while the panel is visible and shows a run.
- The action opens a danger confirmation that names the run. The safe choice is the default.
- A confirmation sends `POST {A}/run/:runId/cancel` for the run that the confirmation named, also when the panel focus moved during the confirmation.
- The TUI reports what really occurred:
  - A run that this abort canceled gets the usual completion notice. The TUI reads the runs again at once, thus the notice and the panel advance do not wait for the next poll.
  - A run that ended before the cancel gets a notice that it already finished, with its status. The TUI does not claim an abort.
  - A failed request gets an error notice with the described error.
- The legend of the panel names the abort chord while it shows a run.
- `RunBlock` loses its `hint` prop and its footer line. Each live mount passes `hint={false}` today, thus only the gallery shows the footer.
- The harness change of the same name settles the cut step rows to `canceled`. Thus the step rows of an aborted run do not continue to show a live step.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `activity-panel`: a new requirement for the abort of the focused run behind a confirmation, with the outcome report and the legend chord.
- `key-bindings`: the declarative panel actions include the abort, and its label comes from its chord.

## Impact

- `src/tui/hooks/activity_panel.ts`: the abort action and its outcome report, with injectable opts for offline tests.
- `src/tui/layout/activity_panel.tsx`: the legend carries the abort chord for a run.
- `src/tui/app.tsx`: the binding layer, the confirmation, and the new legend prop.
- `src/tui/keymap.ts`: the remappable id `app.activity-panel-abort`.
- `src/tui/components/run_block.tsx`, `src/tui/layout/sidebar.tsx`, `src/tui/components/dialog/run_detail_dialog.tsx`, `src/tui/layout/design_gallery.tsx`: the footer and the `hint` prop go.
- The client function `cancelRun` (`src/client/runs.ts`) and the server route exist and do not change.
