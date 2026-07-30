## 0. Consume the local harness build

- [x] 0.1 Land the harness `run-event-stream-read-seam` change first — this change cannot be implemented against the published `@inflexa-ai/harness` version the CLI currently pins
- [x] 0.2 Build and link the local harness with `bun run harness:local`, so `@inflexa-ai/harness` resolves to the working tree rather than the published package
- [x] 0.3 Confirm the new seam is importable from the bare specifier and that `bun run typecheck` sees its types

## 1. Consume the harness run-event stream

- [x] 1.1 Confirm the seam's subscription signature carries no durability-engine type before building on it
- [x] 1.2 Add a run-activity source in `src/tui/hooks/activity_panel.ts` that subscribes to the focused run and holds the current step-activity, following the injectable-seams pattern the module already uses so it is testable offline
- [x] 1.3 Tear the subscription down when focus moves to another run, when the run terminates, and when the screen unmounts; ensure a stale subscription can never write over a newer one
- [x] 1.4 Resolve the panel's label from the folded activity for the running step, omitting the line when none has been reported

## 2. Retire the internals reader from the panel

- [x] 2.1 Remove the panel's use of `readNewestWorkflowStep` / `runWorkflowFamily` and its `readActivity` seam
- [x] 2.2 Leave both functions and `friendlyStepLabel` in place for the headless `inflexa run` wait, and note at the panel's call site why it deliberately does not use them
- [x] 2.3 Verify no `dbos.*` table is read anywhere under `src/tui/`

## 3. Panel chrome

- [x] 3.1 Repaint the panel on `bgRaised` and add a top-only rule in the panel stroke weight with a constant `RUN` title in the muted role
- [x] 3.2 Keep `width="100%"`, `flexShrink={0}`, `flexDirection`, and both paddings untouched — they are what satisfy the bleed and collapse rules
- [x] 3.3 Comment the three non-obvious decisions: why `bgRaised`, why the rule is top-only, and why the frame colour is constant
- [x] 3.4 Add the `tool`-on-`bgRaised` pair to the contrast matrix in `src/lib/design_system.contrast.test.ts` (the theme-system spec already requires a newly-rendered pair to be added in the same change)

## 4. Elapsed clock

- [x] 4.1 Drive the panel's relative-age readouts from a periodic signal rather than recomputing them incidentally during a data refresh
- [x] 4.2 Ensure the ticker is armed only while the panel is showing a run, and disposed with the component
- [x] 4.3 Test that elapsed advances with no change to the underlying run data

## 5. The run card stops carrying live progress

- [x] 5.1 Remove the live progress meter from `src/tui/components/run_card_block.tsx`, keeping the launch record and the settled outcome
- [x] 5.2 Drop any now-unused live state plumbed into the card, and simplify its state type to what remains
- [x] 5.3 Update the card's render tests and the design-gallery fixtures that exercised the live meter

## 6. Bound the sidebar refresh

- [x] 6.1 Bound `refreshSidebarData` so its in-flight guard is released even when its reads never settle, with the bound expressed as a multiple of `POLL_INTERVAL_MS` (start at 3×) rather than an independent constant
- [x] 6.2 On abandonment, leave the previous snapshots in place and report the condition through the logger
- [x] 6.3 Test that a refresh whose reads never settle releases the guard, and that the next tick proceeds and updates the store

## 7. Design gallery

- [x] 7.1 Wrap the run-panel exhibits in a `bg`-painted stand-in column — the gallery's own panel is `bgRaised`, so a raised exhibit rendered directly into it shows no surface separation and would misrepresent the design
- [x] 7.2 Add an in-context exhibit: a short scroll region above the panel and a real chat bar below it (mounted without autofocus), so the rule-against-stream and single-rule-against-input relationships are both visible
- [x] 7.3 Add an exhibit showing the panel with an inert ask prompt docked beneath it, so the adjacent-raised-surfaces case is a documented decision rather than a discovery

## 8. Tests

- [x] 8.1 Add the missing live-path test: the activity label changes across two updates for one focused run (the current suite drives a constant label)
- [x] 8.2 Add a props-change repaint assertion to the panel's render test (it currently renders once per test with static props)
- [x] 8.3 Extend the panel's terminal-height sweep so the assertion set includes the new rule row, which is now the row most exposed to bleed
- [x] 8.4 Pin the `RUN` label's resolved span colour via `captureSpans` in the light-theme legibility block

## 9. Verify

- [x] 9.1 Run `bun run typecheck` and `bun run lint`
- [x] 9.2 Run `bun test` and compare failures against the pre-existing baseline on `main` (the subprocess-timing tests in `inflexa_tool` / `launchWithBinary` fail on `main` under full-suite load and are out of scope)
- [x] 9.3 Run `bun run format:file` on every changed file under `src/`
- [x] 9.4 Drive the real TUI against a live run and confirm the activity line changes as the agent makes tool calls — CONFIRMED by the operator against a live run: the activity line keeps changing as the agent works. This was the one check no test could make. The real seam (`realRunPanelSeams.subscribeActivity`, which calls the harness stream and filters for step activity) is unreachable from the suite by construction — it needs a booted durability runtime and a real workflow emitting real parts, so both sides are covered and the join between them is not
- [x] 9.5 Validate with `openspec validate run-observability-surfaces`

## 10. The legend carries the region; the hint row goes

- [x] 10.1 Move the position indicator off the header row and into the rule's legend, merged into the label itself (`RUN 1/2`), so a content row no longer carries view state
- [x] 10.2 Move the chord hints into the legend and delete the hint row — net one row back, and with a single active run the panel stops spending a whole row on one hint
- [x] 10.3 Degrade the legend by width rather than losing it: opentui renders a border title only when `width >= title.length + 4` (measured exactly across six lengths) and otherwise drops it silently, taking the region's name with it. Pick the longest legend that fits from a ladder ending at the bare region name
- [x] 10.4 Source the panel's own width, not the terminal's — an open sidebar makes them differ by the rail's width, which is precisely the case that would render an unlabelled rule at a 40-column pane
- [x] 10.5 Rewrite the header row's click comment: the indicator no longer sits there, so the "affordance sits on the thing it acts upon" rationale no longer holds. The click stays because the spec requires mouse navigation and the border is not a child that can carry a handler
- [x] 10.6 Test the legend ladder at several widths, including the boundary where the full legend stops fitting, and assert the region name survives at every width
- [x] 10.7 Update the panel's height sweep and the gallery exhibits, whose captions and row expectations assume a hint row
