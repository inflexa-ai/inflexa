## 1. Grain read paths

- [x] 1.1 Add the session-grain read to `src/db/primary_query.ts`: an analysis's rows grouped by `thread_id`, per-quantity `SUM()` plus a call count, NULL mapped to an absent key rather than 0, constrained to one analysis so the scope index stays selective
- [x] 1.2 Add the run-grain read: the same shape grouped by `run_id`, rows with a NULL `run_id` excluded
- [x] 1.3 Add the step-grain read: grouped by `step_id`, scoped to one `run_id`, so steps of other runs cannot appear
- [x] 1.4 Order every grain by input tokens desc, then output tokens desc, then call count desc — lexicographic over named quantities, never a constructed total, which the ledger's no-summing rule forbids
- [x] 1.5 Include an unattributed group for rows carrying neither `thread_id` nor `run_id`, so the grains sum to the analysis headline rather than silently losing background and boot-time work
- [x] 1.6 Test the three reads: groups partition correctly; an all-absent group reads back absent with its call count intact; a run's step read excludes another run's steps; a chat-only analysis yields sessions and no runs
- [x] 1.7 Test the partition property directly — session, run, and unattributed figures summed per quantity equal the analysis headline, on a fixture carrying chat turns, a run, and a call with neither

## 2. The usage dialog

- [x] 2.1 Read the design gallery first and reuse its primitives; add `src/tui/components/dialog/usage_dialog.tsx` composing the dialog shell and the existing list primitives — no new visual pattern invented off to the side
- [x] 2.2 Render the analysis headline plus the breakdowns by session, run, served model, and agent, each row carrying its call count beside its input and output figures — never a summed token count
- [x] 2.3 Drill from a run row into that run's steps, and back; steps are not a top-level grain
- [x] 2.4 Identify sessions and runs by the existing `idTail` helper (`src/tui/hooks/sidebar_live.ts:369`), extending only colliding rows to the shortest distinguishing length; always render the id, and add a known name beside it — never in place of it, so a row reads the same cold or warm
- [x] 2.5 Render the absent and empty states in the surfaces' existing vocabulary, and a read failure as an unavailable state inside the dialog rather than a failure to open
- [x] 2.6 Add the gallery exhibit — every dialog is showcased, so the gallery stays the single source of truth
- [x] 2.7 Render tests including span-colour assertions on a light theme (a char frame cannot prove legibility), the never-summed property, the drill-down, and the unavailable state

## 3. Opening it

- [x] 3.1 Give the sidebar's USAGE section an `onActivate` that opens the dialog, matching how DATA PROFILE and RUNS already open their flows
- [x] 3.2 Wire the open handler from the section only — add no keybinding, and reserve no chord speculatively
- [x] 3.3 Test that activation opens the dialog and that it opens with no harness runtime booted

## 4. Command grains

- [x] 4.1 Confirm each new subcommand's agent-policy classification with the user before registering it — the house rule is to ask, never guess; the parent `usage` command went through the same gate
- [x] 4.2 Add the grain subcommands under `usage` in `src/modules/usage/`, each reporting per-quantity figures and each saying plainly when nothing is recorded at that grain
- [x] 4.3 Register them via `registerAction` with the confirmed policies, descriptions (the docs generator fails without them), and lazy imports
- [x] 4.4 Update the pinned agent-policy snapshots for both the dev-off and dev-on trees
- [x] 4.5 Test that each grain writes nothing — the ledger unchanged AND the anchor heartbeat unchanged, since the parent command's writes-nothing test was vacuous until its fixture was fixed

## 5. Verification

- [x] 5.1 Run lint, typecheck, and the test suite in chunks (`src/db src/lib src/extensions`, `src/cli`, `src/modules`, `src/tui`) — the full suite in one process is OOM-killed on macOS under `--isolate`; regenerate the CLI reference docs
- [ ] 5.2 Drive a real analysis run in the TUI, then open the dialog and confirm the session, run, and step grains agree with the ledger and reconcile with the headline
