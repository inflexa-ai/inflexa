# tui-profile-lifecycle — Tasks

## 1. Harness rider: the profile can be cleared (additive)

- [x] 1.1 Migration in `harness/src/state/init.ts`: `ALTER TABLE cortex_analysis_state ALTER COLUMN data_profile_status DROP NOT NULL` (keep the `'pending'` default); `loadDataProfileStatus` maps a NULL `data_profile_status` to its existing `null` return ("cleared" and "never existed" are indistinguishable to consumers).
- [x] 1.2 `clearDataProfile(pool, analysisId)` in `harness/src/state/data-profile.ts`: single UPDATE nulling status/error/started/completed/result/seed-ids, guarded `WHERE data_profile_status IS DISTINCT FROM 'running'`; resolves `ok(true)` cleared / `ok(false)` skipped (running or no row) — losing stays in the ok channel like the sibling CAS ops.
- [x] 1.3 Barrel-export `clearDataProfile` from `harness/src/index.ts` beside the other ledger ops, with the surrounding comment updated to name the clear contract.
- [x] 1.4 Harness tests (schema-scoped pg rig): clear on completed/failed/pending rows nulls everything and reports true; clear on running reports false and changes nothing; clear on absent row reports false; `loadDataProfileStatus` returns null after a clear; `tsc -p tsconfig.json` + `bun test` green.
- [x] 1.5 Harness spec (direct additive edit, harness tree): add the clearance requirement + scenarios to `harness/openspec/specs/data-profile-rerun/spec.md` (nullable status, the running guard, the null-status read mapping), consistent with its existing CAS-op phrasing.

## 2. cli staging: identity-only enumeration

- [x] 2.1 Extract the input walk in `src/modules/staging/staging.ts` so staging and identity-enumeration share ONE walk (same noise-dir skips, symlink rules, unresolvable-input skips); add `enumerateInputFileIds(analysisId)` returning the `Result`-typed fileId set — no writes, no hashing, no session-tree requirement.
- [x] 2.2 Tests: enumeration equals the staged manifest's fileId set on a fixture with anchored + anchorless + directory + dangling-symlink inputs; runs against a nonexistent session tree without creating anything; unresolvable input skipped in both paths.

## 3. cli trigger module: drift-aware ladder + force variant

- [x] 3.1 Rework `ensureProfileAtParity` (`src/modules/harness/profile_trigger.ts`) per design D1/D4: enumerate first; empty set + existing profile → `clearDataProfile` → `{kind:"cleared"}`; empty + no profile → `no_inputs`; completed + set equality → `already_profiled`; completed + drift → stage → seed → trigger; running → `already_running`; failed → no auto-retry (unchanged outcome); `triggered` carries `restarted: boolean`. Extend `ProfileParitySeams` (enumerate, clear) so the ladder stays offline-testable.
- [x] 3.2 Add `forceReprofile(runtime, analysis)` per design D6: reconcile → status (running → refuse outcome) → stage → seed → trigger; trigger `"failed"` on a failed row takes retry-claim (`tryRetryDataProfile`) + `runDataProfile`; empty enumeration → refuse outcome. Same seams family.
- [x] 3.3 Unit tests over the seams: every ladder branch of 3.1 (incl. null-`result` completed row counts as drifted), every outcome of 3.2 (completed restart, failed retry-claim path, running refusal, empty refusal), set-equality helper order-insensitivity.

## 4. TUI wiring: live edges, notices, surfaces, order

- [x] 4.1 `src/tui/hooks/profile_parity.ts`: map the new outcomes in `driveProfileParity` — `cleared` → info notice + `refreshSidebar` poke (same one-edge rationale as `triggered`); `triggered.restarted` → re-profiling notice copy; swap-guard behavior unchanged. Update `ParityDriverSeams` tests.
- [x] 4.2 Bus edge: subscribe (`Bus.on` + `onCleanup`) to `prov.input_added`/`prov.input_removed` filtered to the open analysis, debounced ~500 ms trailing-edge and coalesced per analysis, armed only while boot is `ready`; fires the drift check bypassing the boot/swap de-dup guard. Offline tests with a fake bus + fake seams (burst coalesces to one check; other-analysis events ignored; pre-ready events ignored).
- [x] 4.3 Completion edge: a Solid effect watching the sidebar profile snapshot's `running → completed` transition re-runs the drift check once per transition (design D5). Test the transition detector logic offline.
- [x] 4.4 Manual surfaces: "Re-profile data" command-palette entry (`src/tui/commands.tsx`) and the keybound action in the profile details dialog (`useDialogBindings` + footer hint, active only when startable: ready + inputs + not running); both drive `forceReprofile` and surface refusals as notices. Gallery: showcase the dialog's hint/action state if the exhibit renders the footer.
- [x] 4.5 Sidebar order: move DATA PROFILE below ANALYSIS in `src/tui/layout/sidebar.tsx` (JSX + the fixed-order comment); adjust any layout test/gallery snapshot pinned to the old order.
- [x] 4.6 `bun run typecheck`, `bun run lint`, full `cd cli && bun test` green; `bun run format:file` on touched src files.

## 5. Docs and spec sync

- [x] 5.1 Update `cli/CLAUDE.md` / `cli/CONTEXT.md` where they describe the sidebar section order or the parity trigger's "only when unprofiled" behavior; keep the module inventory accurate (no new files expected beyond what module docs already cover). — Verified no-op: neither file (nor `cli/docs/`) states the section order or the old parity condition, and no new module files were created.
- [x] 5.2 Validate deltas (`openspec validate tui-profile-lifecycle`) and confirm the harness spec edit (1.5) landed consistently with this change's design.

## 6. Live verification (one scripted pass, frugal)

- [x] 6.1 One tmux capture-pane E2E against the real runtime: open analysis → profile completes → add an input via the palette picker → re-profiling notice + DATA PROFILE flips to running → remove all inputs → cleared notice + "not profiled" → manual "Re-profile data" on a re-added input → restart observed; assert section order SESSION/ANALYSIS/DATA PROFILE/RUNS on the captured grid. Spawn with cwd=cli/; leader keys via two send-keys. — All observed live, plus the NULL-claim wedge fix verified (re-add after clear → "Profiling…" → completed) and the cleared pg row confirmed fully NULL by direct read-only query.
- [x] 6.2 Findings from the live pass triaged and fixed (or spec-corrected when the code's behavior is the better contract), tests updated accordingly. — One in-change finding was caught and fixed BEFORE the live pass (the NULL-status trigger wedge; fixed at the start CAS + spec'd + pg-tested + verified live). One pre-existing, out-of-scope finding: `resolveContext` ignores the `--analysis <id|name>` flag on an anchor holding multiple analyses, so `inflexa profile --analysis <ref> --status` dies with the "Multiple analyses here" picker (observed against unmodified resolution code; affects profile/run text commands only, not this change's TUI paths).
