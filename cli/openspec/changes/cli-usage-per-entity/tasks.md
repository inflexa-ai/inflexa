## 1. The shared notation

- [x] 1.1 Add the token-figure formatter beside the existing figure helpers, rendering `↑<in> ↓<out>` from `GLYPHS.arrowUp`/`arrowDown` — never an inlined glyph literal, per the design system's rule
- [x] 1.2 Omit an absent arm entirely and return a distinguishable empty result when nothing was reported, so a caller renders a muted absence rather than a zero; a provider-reported zero still prints
- [x] 1.3 Add the detailed variant used where there is room: input with cache write/read nested beneath it, output beside — nested, never levelled, because the cache quantities are parts of input
- [x] 1.4 Test the formatter directly: both arms, each arm alone, nothing reported, a reported zero, and the width against the rail's design width
- [x] 1.5 Replace every existing call site of the verbose `in`/`out` rendering with the formatter, and delete the old one so a second notation cannot survive

## 2. Read paths

- [x] 2.1 Export the data-profile run literal from the harness so the CLI recognises profile rows against the harness's own value; import it here rather than writing the string
- [x] 2.2 Add the data-profile totals read, and exclude that run id from `listAnalysisUsageByRun` and from every other run grouping — the profile is a grain, not a run
- [x] 2.3 Add the session-inclusive totals read (every row carrying the thread, runs included) as a function whose name says it includes runs, distinct from the session GRAIN read that excludes them
- [x] 2.4 Add a session's by-served-model and by-agent groupings
- [x] 2.5 Add the batched per-analysis totals read — one query returning a total per analysis, never one query per row
- [x] 2.6 Add a per-run totals read for the run rows and run detail, reusing the existing scope-constrained shape
- [x] 2.7 Test each read against a fixture holding the real ledger's shape: a run stamped with its launching thread, a profile with a run id and no thread, and chat-only rows — assert the inclusive and grain session reads differ by exactly the run
- [x] 2.8 Test that a quantity no row reported reads back absent from every new read, never zero

## 3. Sidebar

- [x] 3.1 Re-scope the USAGE section to the open session's inclusive totals, rendered with the detailed variant (cache nested under input); keep the muted-absence and unavailable states
- [x] 3.2 Drop `messageCount` from the usage memo's dependencies and refresh on the chat-status transition out of busy, on the existing bounded poll, and on the run-observation event already observed — no second timer
- [x] 3.3 Test the refresh contract at the level the bug lived: a completed turn advances the figure; a conversation past the store's message cap still advances; an idle rail issues no query
- [x] 3.4 Carry the data profile's figures on the DATA PROFILE section and each run's on its RUNS row, leaving the section rendered when a usage read fails
- [x] 3.5 Thread each step's figures onto the published active-run step views inside the existing generation-token guard, keyed by run id, and issue no step usage read when no run is active
- [x] 3.6 Render the step figure in `RunBlock` from the view it is handed — no lookup inside the renderer, so the block stays gallery- and test-drivable offline

## 4. Dialogs and the picker

- [x] 4.1 Narrow the usage dialog to the open session's by-model and by-agent groupings; remove the by-session, by-run, and by-step tables and the run→steps drill-down
- [x] 4.2 Rebuild the dialog's headline as input-left / output-right with the cache quantities nested under input, replacing the vertical label/value stack
- [x] 4.3 Add the run's figures to `runDetailLines` as one more property line, in the same vocabulary as `status`/`started`/`duration`
- [x] 4.4 Add the profile's figures to `profileDetailLines` the same way
- [x] 4.5 Add each run's figures to the runs picker rows
- [x] 4.6 Add each analysis's total to the Switch analysis picker rows from the batched read, leaving every row listed and selectable when the usage read fails
- [x] 4.7 Rewire `openUsage()` in `app.tsx` to the narrowed dialog's session-scoped signature, dropping the drill-down call site and its now-dead imports

## 5. Design gallery

- [x] 5.1 Update the usage exhibits to the narrowed dialog and the new headline layout, and add exhibits for a figure with one arm, with none, and with the cache breakdown — the gallery is the single source for these surfaces and a state absent from it is a state nobody reviews
- [x] 5.2 Verify every new or changed surface on a light theme, not only the dark default, and confirm each information-bearing figure resolves an explicit foreground

## 6. Verification

- [x] 6.1 `bun run typecheck`, `bun run lint`, and `bun run format:file` on every changed file under `src/`
- [x] 6.2 `bun run test` over the touched areas in chunks (the runner leaks per test file; the full suite in one process exhausts memory)
- [x] 6.3 Sweep the rail's layout across a range of terminal heights and at the design width — these figures add rows to a column that already wraps, and the bugs are size-dependent
- [x] 6.4 Confirm against a real ledger that the rail's session figure, the profile's, and each run's agree with `inflexa usage` under their stated readings — the session figure exceeding the session grain by exactly its runs is the expected difference, not a defect

## 7. Corrections found in review

- [x] 7.1 Add the labelled form beside the compact one in the shared figure module, built from the same quantities so the two can never disagree about a value; keep the absent-arm and reported-zero behaviour identical across both
- [x] 7.2 Switch the sidebar USAGE section to the labelled form, leaving the DATA PROFILE and RUNS row decorations compact
- [x] 7.3 Switch the usage dialog's headline to the labelled form, leaving its grouping rows compact
- [x] 7.4 Align the dialog headline's output quantity to the panel's trailing edge — an arm that grows and an arm at its natural width, not two equal halves, which leaves the output figure floating mid-panel adjacent to nothing; quantities nested under an arm stay aligned to that arm
- [x] 7.5 Pass the runtime's `UsageRecorder` in the chat turn's `runAgent` options, exposing it from the runtime handle and threading it through the turn args; `runAgent` reads it from the options and silently falls back to the no-op, so the composition root alone never covered this loop
- [x] 7.6 Test it against the options the PRODUCTION path builds — a fake seam asserting it was called cannot observe a missing field in the real bag, which is how the conversation agent went unrecorded while a scenario claiming its coverage passed
- [x] 7.7 Correct the false claim at the recorder's construction site that it reaches "every loop the cli can reach (chat, …)", so the comment states what the wiring actually guarantees
- [x] 7.8 Update the design gallery's usage exhibits to the labelled headline and the edge-aligned arms, and verify on a light theme
- [x] 7.9 `bun run typecheck`, `npx eslint src`, `bun run format:file`, and the touched suites in chunks
