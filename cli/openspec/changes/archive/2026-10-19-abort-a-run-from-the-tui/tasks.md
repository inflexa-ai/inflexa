# Tasks

## 1. The abort action and its keybinding id

- [x] 1.1 Add `"app.activity-panel-abort": "c"` to `KEYBIND_DEFAULTS` in `src/tui/keymap.ts`, with a comment that the value is the final stroke after the leader. Make sure that `bun run test src/tui/keymap.test.ts src/tui/keymap_chord_uniqueness.render.test.tsx` passes.
- [x] 1.2 In `src/tui/hooks/activity_panel.ts`, add the `RunAbortOpts` type (`confirm`, `cancel`, `refresh`, `notify`), the default realizations of `cancel`, `refresh`, and `notify`, and `abortFocusedRun(analysisId, opts)`. The function captures the focused run one time, and it returns for a profile or for no subject. It keeps the pending guard and maps each outcome as `design.md` states. Make sure that the reset test hook also clears the pending guard.
- [x] 1.3 Add offline tests to `src/tui/hooks/activity_panel.test.ts` with injected opts, and make sure that the file passes. Cover each scenario of the new `activity-panel` requirement, except the legend:
  - confirmed and canceled with each ledger settled: a refresh and no notice
  - confirmed and canceled with a ledger that did not settle: a refresh and a warning notice that names the ledger
  - declined
  - already finished: an info notice with the status, and no abort claim
  - a `finalStatus` other than `canceled`
  - the named run after a focus move
  - a failed request: an error notice and a refresh
  - a profile
  - the pending guard for one run, and no block for a different run.

## 2. The legend of the panel

- [x] 2.1 Add the required `abortKeyLabel` prop to `ActivityPanelProps`, and pass the label and the subject kind to `fitPanelLegend` in `src/tui/layout/activity_panel.tsx`. For a run, the chord part names `abort` after `next` and `hide`. For a profile, the legend does not change. The ladder sheds the whole chord part first.
- [x] 2.2 Update each `ActivityPanel` call site: `src/tui/layout/design_gallery.tsx`, `src/tui/theme_contrast.render.test.tsx`, and `src/tui/layout/activity_panel.render.test.tsx`. Add render tests for the scenario "The legend names the abort chord for a run only" and for the ladder at a narrow width. Make sure that `bun run test src/tui/layout/activity_panel.render.test.tsx src/tui/theme_contrast.render.test.tsx` passes.

## 3. The binding and the confirmation in the chat app

- [x] 3.1 In `src/tui/app.tsx`, add a `useBindings` layer with `mode: MODE_BASE`, `enabled: activityPanelVisible() && focusedSubject()?.kind === "run"`, and the binding `leaderKeybind("app.activity-panel-abort")` with `desc` and `group: "View"`. Its `run` calls `abortFocusedRun` with opts whose `confirm` pushes `ConfirmDialog` (`tone="danger"`, default `cancel`, `cancelLabel="keep running"`, title `Abort run`, a message that names the run). Pass `abortKeyLabel={sequenceLabel(leaderKeybind("app.activity-panel-abort"))}` to `ActivityPanel`.
- [x] 3.2 Add render tests in `src/tui/app_activity_panel.render.test.tsx`. While a run shows, the chord opens the confirmation in the danger tone, the confirmation names the run, and the active choice is `keep running`. While a profile shows, the chord opens nothing. Make sure that the which-key overlay lists the binding only while a run shows. Make sure that the file passes.

## 4. The `RunBlock` footer

- [x] 4.1 Remove the `hint` prop and the footer line from `src/tui/components/run_block.tsx`. Remove the `hint={false}` attributes from `src/tui/layout/sidebar.tsx`, `src/tui/components/dialog/run_detail_dialog.tsx`, and `src/tui/layout/design_gallery.tsx`. Make sure that `rg "esc detach|hint=\{" src/tui` finds no `RunBlock` footer or `hint` prop, and that `bun run test src/tui/components/dialog/run_detail_dialog.render.test.tsx` passes.

## 5. Verification

- [x] 5.1 Run `bun run format:file` on each changed file in `src/`, then `bun run typecheck` and `bun run lint` in `cli/`. Make sure that they pass.
- [x] 5.2 Run the full cli suite one time with `bun run test`. Make sure that it passes. Result: 3963 pass, 2 fail. The two failures are outside this change: `src/modules/prov/prov.test.ts` fails on the stale installed `@inflexa-ai/prov-kernel` (its dist has no `ApprovePlan`), and the farm parity test needs the Python `packaging` module, which the machine does not have.

## 6. Review corrections

- [x] 6.1 In `abortFocusedRun`, show an `error` notice that the run row did not settle when the result has `outcome: "canceled"` and a `finalStatus` that is not terminal. Keep the "already finished" notice for terminal statuses only. Add a test, and make sure that it passes.
- [x] 6.2 After the refresh on a successful cancel, show an `info` notice with `queue: true` that the run was canceled when the loaded runs snapshot does not hold the run. Add a test, and make sure that it passes.
- [x] 6.3 Join the names of the ledgers that did not settle so that the sentence reads correctly with two or three names, and update the expected text of the test.
- [x] 6.4 Add render tests in `src/tui/app_activity_panel.render.test.tsx` through the real dialog: a confirm sends the cancel for the named run, esc sends no cancel and closes the dialog, and the abort chord under the open dialog opens no second dialog. Make sure that the file passes.
- [x] 6.5 Seed an active run in the sweep of `src/tui/keymap_chord_uniqueness.render.test.tsx`, so that the abort layer is enabled and its leader stroke takes part in the check. Make sure that the file passes.
- [x] 6.6 Remove the stale footer references in the comments at `src/tui/components/run_block.tsx:148` and `src/tui/layout/design_gallery.tsx:691`.
- [x] 6.7 When `abortFocusedRun` raises its own "was canceled" notice, mark the run as announced in the dedup state of `src/tui/hooks/run_completion.ts` (the `(runId, status)` reaction key, and the `seenActive` entry). Thus a later poll that shows the run terminal does not announce it a second time. Add a test with a failed refresh, then a loaded snapshot that holds the canceled run, and make sure that only one notice shows.
