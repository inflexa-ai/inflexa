# tui-profile-lifecycle

## Why

The data profile only springs to life when a chat opens on an analysis with **no** completed or running profile (`ensureProfileAtParity` short-circuits at `completed`, `src/modules/harness/profile_trigger.ts:87`). It never looks at the current input set again: add an input after profiling and the profile is silently stale forever; remove every input and a "completed" profile keeps describing data that no longer exists. There is also no way to re-profile from the product surface (only the dev-channel `inflexa profile`), and the sidebar orders DATA PROFILE before ANALYSIS even though the profile is *derived from* the analysis's inputs. Cortex managed already solves the first two (staleness re-trigger in `chat-context`, a retry route) — this closes the parity gap the PR #45 program left open.

## What Changes

- **The profile follows input operations.** The parity ladder becomes drift-aware: instead of skipping whenever a completed profile exists, it compares the analysis's *current* input file-identity set against the completed profile's `result.inputFileIds` (already persisted by the harness) and re-triggers on drift. The check fires on the existing edges (runtime `ready`, analysis swap) **and live** on input mutations (the `prov.input_added` / `prov.input_removed` bus events all three TUI edit surfaces already emit), debounced per analysis, plus once when a running profile completes (so edits made mid-profile aren't lost until the next open).
- **Removing all inputs clears the profile.** When the current input set is empty and a profile exists, the profile is cleared — the sidebar honestly returns to "not profiled" instead of serving a stale summary. Requires a small additive harness rider: a `clearDataProfile` ledger op and a nullable `data_profile_status` (NULL = no profile), since today "no profile" is only representable by the analysis-state row not existing at all.
- **Manual re-trigger from the TUI.** A "Re-profile data" command-palette entry and a keybound action inside the DATA PROFILE details dialog force a re-profile: completed rows restart through the existing trigger CAS, `failed` rows take the retry-claim + `runDataProfile` path the profile command already proves. Refused only while a profile is running.
- **Cheap drift checks.** An identity-only input enumeration (same deterministic `fileId` derivation as staging, stat/readdir cost, no content hashing, no tree writes) so drift is checkable on every open and every input edit without re-hashing gigabytes; the full staging pass runs only when a (re-)trigger actually fires.
- **Sidebar order.** Sections reorder to SESSION, ANALYSIS, DATA PROFILE, RUNS — pipeline order (inputs feed the profile, the profile feeds runs).

Out of scope: content-edit detection (same path, new bytes — fileIds are path-identity, matching Cortex; the manual re-trigger is the escape hatch), auto-retry of `failed` profiles (managed parity: retry is manual), and any chat gating on profile state.

## Capabilities

### New Capabilities

_None — every behavior extends an existing capability._

### Modified Capabilities

- `tui-harness-chat`: the "data profile auto-triggers at parity" requirement becomes drift-aware (re-trigger on input-set drift, clear on empty set, live re-check on input operations and on profile completion); a new requirement adds the manual re-trigger surfaces.
- `tui-layout`: the sidebar fixed section order changes to SESSION, ANALYSIS, DATA PROFILE, RUNS.
- `sidebar-live`: the refresh-edges requirement gains the input-operation edge and the trigger/clear pokes; the profile details view gains the re-profile action.
- `data-profile-launch`: the deliberate-action requirement's TUI parity condition is restated drift-aware, and input operations join the deliberate trigger edges.
- `input-staging`: new requirement for the identity-only enumeration contract (same `fileId` space as staging, read-only, no hashing).

The harness-side rider (`clearDataProfile`, nullable `data_profile_status`, `loadDataProfileStatus` mapping NULL to "no profile") is spec'd in the **harness tree** (`harness/openspec/specs/data-profile-rerun/spec.md`) via a direct additive edit tasked in this change — the cli tree's deltas cannot sync across subsystems.

## Impact

- **cli**: `src/modules/harness/profile_trigger.ts` (drift rung, `cleared` outcome, force variant), `src/modules/staging/staging.ts` (shared identity walk), `src/tui/hooks/profile_parity.ts` (bus subscription, completion-edge re-check, new outcome mapping), `src/tui/layout/sidebar.tsx` (order), `src/tui/commands.tsx` (palette entry), the profile details dialog (action key), keymap/which-key.
- **harness** (additive rider): `src/state/data-profile.ts` (+`clearDataProfile`, NULL-status mapping), `src/state/init.ts` (nullable-status migration), `src/index.ts` (barrel export), `openspec/specs/data-profile-rerun/spec.md`.
- **No new dependencies.** No bus contract changes (consumes existing `prov.*` events). SQLite schema untouched.
