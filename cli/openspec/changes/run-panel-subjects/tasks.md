## 0. Consume the local harness build

- [x] 0.1 Land the harness `data-profile-event-stream` change first — this change cannot be implemented against the published `@inflexa-ai/harness` version the CLI pins, because it needs `DataProfileStatus.workflowId`
- [x] 0.2 Build and link the local harness with `bun run harness:local`, so `@inflexa-ai/harness` resolves to the working tree — already satisfied: `node_modules/@inflexa-ai/harness` is a symlink to `../../../harness`, and the harness `tsconfig.json` emits `dist/` with declarations, so every harness typecheck rebuilt it
- [x] 0.3 Confirm `DataProfileStatus.workflowId` is visible to `bun run typecheck` through the bare specifier
- [x] 0.4 Teach the CLI's `DataProfileStatus` fixtures the new field. The harness made `workflowId` REQUIRED (not optional), which is correct for a read shape where every field is present on a real read — but it broke `bun run typecheck` in 5 files that build the shape literally (8 errors across `modules/harness/profile_trigger.test.ts`, `tui/hooks/profile_parity.test.ts`, `tui/hooks/sidebar_live.test.ts`, `tui/layout/design_gallery_fixtures.ts`, `tui/layout/sidebar.render.test.tsx`). This is the precondition for anything else here typechecking, so it lands first

## 1. The store publishes the profile as a subject

- [x] 1.1 Add the profile progress type in `src/tui/hooks/sidebar_live.ts` — identity, start time, recorded workflow id, and `stale` — with a doc stating why it carries no counts, no step views, and no name (the name is a constant belonging to the render, not a ledger fact)
- [x] 1.2 Publish it from `refreshSidebarData`, built from the profile row the refresh already reads, inside the SAME generation-token guard as the run entries so no second reader or staleness rule appears
- [x] 1.3 Publish only for a `running` profile — NOT `pending`. Comment why: the ledger writes the start time only on the transitions into `running`, so a pending entry would be a name beside a blank elapsed and a blank activity, and `pending` means queued rather than in flight
- [x] 1.4 Leave `hasActiveWork` unchanged, so a pending profile still arms the poll — that decides whether to keep looking, not whether there is anything to show
- [x] 1.5 Carry a previous entry forward and mark it `stale` when the profile read fails, re-stamping only on the fresh→stale edge — mirror `setActiveRun`'s carry-forward exactly, including its identity-preserving branch for an already-stale entry
- [x] 1.6 Verify the RUNS section's data is untouched: `activeRunProgress` keeps its existing shape and contents, and the rail renders identically

## 2. The ordered subject set

- [x] 2.1 Add the subject union — a run arm carrying `ActiveRunProgress` verbatim, a profile arm carrying the profile entry — so a profile with step views is not representable
- [x] 2.2 Derive the ordered subject set as a memo over the two published cells, runs first in their existing newest-first order, then the profile; comment that ordering by KIND departs from this module's recency rule on purpose, and why (a parity profile enters the set without the user asking)
- [x] 2.3 Confirm the memo introduces no writer and holds no state of its own

## 3. Focus, position, and the subscription

- [x] 3.1 Retarget `focusedRun`, `activeRunCount`, and `focusedRunPosition` in `src/tui/hooks/run_panel.ts` at the subject set, keeping the derived-not-stored auto-advance property intact — renamed to `focusedSubject` / `activeSubjectCount` / `focusedSubjectPosition` / `focusedSubjectActivity` / `focusNextSubject`, since an accessor named for a run that can return a profile is a false name. The focus key is kind-tagged (`run:{runId}` / `profile:{analysisId}`) so a run id and an analysis id, which come from spaces nothing forces apart, cannot collide. The profile keys on its ANALYSIS, not its workflow id: that id is null until the body records it and changes again on a re-profile, so keying on it would make a focused profile stop resolving mid-flight and silently slide focus back to the head of the set
- [x] 3.2 Replace the private `focusedRunId` memo with a focused-STREAM-id memo: the run id for a run, the recorded workflow id for a profile — the one value the harness seam takes either way, so the subscription effect's shape does not change
- [x] 3.3 Leave the effect keyed on that memo so a five-second poll minting fresh objects cannot re-open the stream, and so a re-profile's new workflow id re-subscribes for free
- [x] 3.4 Resolve a profile with no recorded workflow id to no stream id, so no subscription opens and the subject renders without an activity line
- [x] 3.5 Remove the `part.runId` filter from the activity fold, with a comment recording BOTH reasons: a profile's part carries a constant literal the harness contract forbids keying on, and the filter was already redundant because the subscription is scoped to one workflow
- [x] 3.6 Confirm the generation token and the clear-on-focus-change still guard late parts — those are the guards that do the work, and they must not be removed alongside the redundant filter
- [x] 3.7 Pin the invariant the removal rests on with a test (see 7.12). Dropping a guard on the strength of an invariant obliges the change to pin it — otherwise the absence reads as an oversight, someone restores the check, and profiles silently stop reporting
- [x] 3.8 Retarget the dismissal-expiry effect at the subject count

## 4. The panel renders a subject

- [x] 4.1 Change `RunActivityPanelProps` to take the subject union in place of `progress: ActiveRunProgress | undefined`
- [x] 4.2 Render the run arm exactly as today — header with counts, frontier rows, activity line
- [x] 4.3 Render the profile arm as header (marker, the constant name `Data profile`, elapsed) plus activity line only, with no count and no step rows, and comment why a synthesized `1` denominator was rejected
- [x] 4.4 Keep `Data profile` in the render rather than on the subject, and comment why: it is the same string for every analysis, so carrying it through the store would dress a constant up as data — and it matches the sidebar's `DATA PROFILE` label deliberately, so both surfaces name the work identically
- [x] 4.5 Use the warning glyph in the warning role for the profile's marker — the pair the rail's running-profile line already uses — so one piece of work looks like itself on both surfaces
- [x] 4.6 Keep `width="100%"`, `flexShrink={0}`, `border={["top"]}`, both paddings, and the constant frame colour untouched; they are what satisfy the bleed, collapse, and second-focus-ring rules

## 5. The legend carries the subject's region

- [x] 5.1 Rename `fitRunLegend` to `fitPanelLegend` and give it a `region` parameter, leaving the ladder's shed order (chords, then position, then bare name) unchanged. The rename is required, not tidying: the function's output for a focused profile is a legend reading `PROFILE`, so the old name would be false at the call site and nothing would typecheck it
- [x] 5.2 Supply the region from the focused subject's kind
- [x] 5.3 MEASURE the profile region's fitting widths rather than deriving them from the run's — MEASURED at `activeCount: 3, position: 2`: `PROFILE`'s full legend is 41 columns and first fits at **45** (44 sheds to `PROFILE 2/3`), the position rung holds to **17** (16 sheds to `PROFILE`), and the bare rung to **13**. Below 13 opentui drops even ` PROFILE `, so a never-unlabelled sweep for this region must start at 13 — not the 12 the `RUN` sweep uses
- [x] 5.4 Confirm the run region's measured boundaries are unchanged, so the existing pinned boundary columns stay valid rather than being re-based to hide a regression — CONFIRMED byte-identical: `RUN` full legend 37 columns, first fits at 41, position rung to 13, bare rung to 9. The pinned 100/41/40/14 cases stand as written

## 6. Design gallery

- [x] 6.1 Add a profile-subject exhibit to `src/tui/layout/design_gallery.tsx`, wrapped in the same `bg`-painted stand-in column the run exhibits use (the gallery's own panel is `bgRaised`, so a raised exhibit rendered directly into it shows no surface separation)
- [x] 6.2 Add an exhibit showing a run and a profile in one active set, so the ordering decision and the position indicator are both visible — rendered as the profile at position 2 of 2, which is the honest way to show it: the panel shows ONE subject, so the ordering is visible in the profile never being position 1, not in two panels side by side. A fourth exhibit was added beyond the task list for the not-yet-recorded workflow id, since that is a normal state the panel must render and it had no showcase
- [x] 6.3 Add the profile fixture to `src/tui/layout/design_gallery_fixtures.ts` beside the existing run-progress fixtures
- [x] 6.4 Add a stale-profile exhibit, so the carry-forward's muted unavailable rendering is showcased rather than only tested

## 7. Tests

- [x] 7.1 Test the store: a running profile publishes an entry, a terminal profile's entry clears, and an entry with no workflow id is still published
- [x] 7.2 Test that a `pending` profile publishes NO entry while still arming the poll — the two halves of that decision are independent and each could regress alone
- [x] 7.3 Test the carry-forward: a failed profile read keeps the previous entry and marks it stale, and a recovered read republishes it fresh — plus the identity-preservation detail: a SECOND consecutive failure returns the same object (`Object.is`), because minting an equal-but-new one would re-fire every consumer memoized on it for a value that cannot have changed
- [x] 7.4 Test the ordering: a profile sorts behind every run, a profile triggered after a run does not take the head, and runs keep their newest-first order
- [x] 7.5 Test navigation across kinds: with one run and one profile active, advancing moves between them and wraps
- [x] 7.6 Test auto-advance off a terminal profile — to a live run when one remains, and to an empty panel when none does — driven by the fixture's ledger row going terminal, never by a setter, so it genuinely exercises derived focus with no writer and no fix-up effect. A `failed` profile is pinned as terminal alongside `completed`
- [x] 7.7 Test the profile's live path: the activity label changes across two updates for one focused profile (not a constant label)
- [x] 7.8 Test that a profile subject renders no count and no step rows, asserting on the absence rather than only on the presence of the activity line — the absence is asserted as `not.toMatch(/\d+\s*\/\s*\d+/)` (catching a stray `0/0` AND a synthesized `0/1`, run at `activeCount: 1` so the legend contributes no `n/m` of its own) and `not.toContain(GLYPHS.arrowRight)` — the arrow is the frontier row's own marker, so an EMPTY `<For>` row is caught, which a label-absence check would miss. Both were verified non-vacuous against a run subject
- [x] 7.9 Test the legend at the profile region's measured boundary widths, including the width where its full legend stops fitting, asserting the region name survives at every width — each narrow case also asserts an ABSENT string, because every shorter rung is a PREFIX of the full legend, so `toContain` alone would pass on a panel that never shed anything
- [x] 7.10 Extend the panel's terminal-height sweep to cover a focused profile, since the row count differs from a run's
- [x] 7.11 Pin the profile marker's resolved span colour via `captureSpans` — a character-frame assertion cannot prove a glyph is visible — on `github-light`: fresh = `warning` `#966400`, stale = `fgMuted` `#57606a`. Each case asserts the colour is neither `#ffffff` NOR the other state's role, without which a marker frozen in `warning` would satisfy the fresh case
- [x] 7.12 Test the invariant behind the dropped filter: deliver a part carrying a DIFFERENT subject's identifier on the focused subject's subscription and assert the panel still shows it, so re-adding the check fails a test instead of silently breaking profiles — self-checking rather than mutation-verified: the test first asserts the delivered part's `runId` differs from BOTH the stream id and the analysis id, then that the label surfaces, so a comparison re-added against either value makes the activity null and fails

## 8. Verify

- [x] 8.1 Update the `warning` row's `ref` in `src/lib/design_system.contrast.test.ts` to name the panel's profile marker; confirm `warning`-on-`bgRaised` is already covered so no new pair is needed
- [x] 8.2 Run `bun run typecheck` and `bun run lint` — both clean
- [x] 8.3 Run `bun test` and compare failures against the pre-existing baseline on `main` (the subprocess-timing tests in `inflexa_tool` / `launchWithBinary` fail on `main` under full-suite load and are out of scope) — **2321 pass, 1 skip, 7 fail** across 140 files. All 7 are the documented baseline: 6 in `spawnInflexa — process bounds` (`modules/harness/inflexa_tool.test.ts`) and 1 in `launchWithBinary` (`modules/embedding/local-provider.test.ts`). Neither file is touched by this change, and both pass **76/76 in isolation** — so the failures are load-dependent subprocess timing, not regressions
- [x] 8.4 Run `bun run format:file` on every changed file under `src/` — all 15 changed files verified prettier-clean
- [x] 8.5 Check the panel on a light theme with a focused profile — `github-light` is the sharpest case, where an unresolved foreground is invisible rather than merely wrong — CHECKED and now pinned by 7.11 rather than left to a one-off inspection; `theme_contrast.render.test.tsx` also gained a `RunActivityPanel (profile)` sweep entry, since the profile arm paints spans the run arm never does
- [ ] 8.6 Drive the real TUI against a live profile and confirm the activity line changes as the profiler works, including during sandbox provisioning — the one check no test can make, since the real seam needs a booted runtime and a real workflow emitting real parts
- [x] 8.7 Validate with `openspec validate run-panel-subjects` — valid
