# tui-profile-lifecycle — Design

## Context

PR #45's program landed the parity auto-trigger (design D8 of `tui-harness-chat`): `ensureProfileAtParity`
(`src/modules/harness/profile_trigger.ts`) runs reconcile → status → stage → seed → trigger, fired by
`watchProfileParity` (`src/tui/hooks/profile_parity.ts`) on boot-`ready` and analysis swap. It short-circuits
whenever the ledger shows `completed` (`profile_trigger.ts:87`) — the profile never follows the input set
afterwards. The pieces this change composes already exist:

- The harness ledger stores both sides of Cortex's staleness comparison: `DataProfileStatus.result.inputFileIds`
  (what the completed profile covered) and `seedInputFileIds` (`harness/src/state/data-profile.ts:12-24`).
  Cortex's `chat-context` route diffs these and silently re-triggers (`cortex/harness/routes/analyses.ts:216-229`);
  the harness `data-profile-rerun` spec names snapshot-diff staleness as the intended mechanism.
- `triggerDataProfile` already restarts completed rows via the `tryRerunDataProfile` CAS ("restarted"); failed
  rows have the retry-claim + `runDataProfile` path `inflexa profile` proves (`profile.ts:272-283`).
- `deriveFileId` is deterministic from `anchorId|path(+subpath)` (`staging/staging.ts:44-47`) — set comparison
  across sessions is meaningful.
- All input mutations (TUI pickers and text commands alike) emit `prov.input_added`/`prov.input_removed` on the
  bus (`modules/analysis/analysis.ts:134,156`).
- `reconcileStagedTree` already mirrors the staged tree to the current inputs at staging time (`staging.ts:199`).

Constraints: harness-first boundary (ledger writes are harness capabilities, the cli composes them); no-litter
(read-only checks on passive-ish edges, writes only on deliberate actions — input edits and explicit re-profile
are deliberate); frugality (drift checks must not hash gigabytes on every open); neverthrow-first; the keymap,
dialog, palette, and gallery subsystems' house rules.

## Goals / Non-Goals

**Goals**
- The profile tracks input-set operations automatically (add/remove, including files appearing inside directory
  inputs), on every edge where the TUI can act: open, swap, live edits, profile completion.
- An emptied input set clears the profile — "not profiled" is truthful again.
- A deliberate re-profile exists in the product surface (palette + profile dialog).
- DATA PROFILE renders between ANALYSIS and RUNS.

**Non-Goals**
- Content-edit detection (same path, new bytes). fileIds are path-identity — matching Cortex, where a re-upload
  mints a new file id. Manual re-trigger is the escape hatch. A future rider could persist stat heuristics
  (size/mtime) in the ledger; deliberately not now.
- Auto-retrying `failed` profiles (managed parity: Cortex's retry route is user-driven). An auto-retry loop on a
  deterministic failure would burn sandbox/model cost forever.
- Any chat gating on profile state, and any daemon/transport work (hard rule 2).

## Decisions

### D1 — Drift = current enumerated fileId set vs the completed profile's `result.inputFileIds`

Cortex compares `seedInputFileIds` vs `result.inputFileIds` because its seed route updates the seed set on every
input change independent of profiling. Our seed only ever happens inside stage → seed → trigger, so seed-vs-result
is vacuously equal; the honest comparison is **current inputs (enumerated now) vs what the profile actually
covered** (`result.inputFileIds`). A completed row with a null/absent `result` (upstream contract violation)
counts as drifted — re-profiling heals it. Order-insensitive set equality.

### D2 — Identity-only enumeration, staging only on fire

`stageInputs` hashes every file (sha256) and rewrites the tree — unacceptable on every open/edit for
bioinformatics-sized inputs. New `enumerateInputFileIds(analysisId)` shares the *same walk* as staging (extracted,
not duplicated — the spec pins that they cannot drift) but only derives ids: stat/readdir cost, zero writes, no
session tree required. The ladder enumerates to decide; only a decision to (re-)trigger runs the full
`stageInputs`. Alternative rejected: always stage (self-heals the tree as a side effect, but hashes content on
every edge — the cost is unbounded in data size, and tree mirroring already happens on every actual trigger).

### D3 — Clearing is a harness ledger capability: `clearDataProfile` + nullable status

"No profile" is currently representable only by the analysis-state row not existing; the row must exist (it
carries analysis status/context/seed ids), and resetting to `'pending'` is wrong — the sidebar treats pending as
active work and would arm its poll forever (`sidebar_live.ts:197-199`), and pending semantically means "about to
run". So, harness-first: migration drops NOT NULL on `data_profile_status` (NULL = no profile — the DEFAULT
'pending' stays for the insert path), `loadDataProfileStatus` maps a NULL status to its existing `null` return
("no profile row" and "cleared profile" are deliberately indistinguishable to consumers), and
`clearDataProfile(pool, analysisId)` nulls status/error/timestamps/result/seed-ids **guarded `WHERE
data_profile_status IS DISTINCT FROM 'running'`** — clearing never fights a live workflow (the completion-edge
re-check clears afterwards; a `completeDataProfile` landing after a clear is likewise re-checked on the next
edge). Rider is additive: new function + barrel export + migration; `DataProfileStatus`'s public shape is
unchanged. Spec'd in the harness tree (`data-profile-rerun`) by direct additive edit — the cli change's deltas
cannot sync across subsystems; the edit is tasked and reviewed here.

### D4 — Ladder outcomes grow; notices map in the driver

`ProfileParityOutcome` gains `{ kind: "cleared" }` and `triggered` gains `restarted: boolean` (notice copy:
"Profiling…" vs "Re-profiling…" — the trigger result already distinguishes started/restarted). `cleared` maps to
an info notice and pokes `refreshSidebarData` exactly like `triggered` (both are ledger edges outside the
sidebar's own refresh triggers — the rationale documented at `profile_parity.ts:100-110` extends). `no_inputs`
stays the silent empty-and-unprofiled outcome. The swap-guard contract is unchanged: a mid-flight analysis swap
drops side effects and notices (`currentAnalysisId` live read).

### D5 — Live edges: bus subscription + completion watch, both in the parity hook

`profile_parity.ts` gains the two new edges beside `watchProfileParity`:

- **Input mutations**: `Bus.on("inflexa", …)` filtering `prov.input_added`/`prov.input_removed` for the *open*
  analysis (TUI house rule: filter by `analysisId`, `onCleanup` the subscription). Debounced (~500 ms) and
  coalesced per analysis — `addInputs` emits one event per path and the Edit-inputs picker commits bursts. Only
  armed while boot is `ready`; pre-ready edits are covered by the `ready`-edge check.
- **Completion edge**: a Solid effect watching the sidebar's profile snapshot for the `running → completed`
  transition (the sidebar already polls while a profile runs, so the transition is observed without new
  polling), re-running the drift check once per transition.

The boot/swap de-dup guard (`lastTriggeredAnalysisId`) keeps its job for repaint/settle de-dup; the new edges
bypass it deliberately — they are event-driven, and a no-drift check is cheap by D2. Alternative rejected:
poking the ladder directly from the three palette command handlers — the bus catches every current and future
mutation path in one place, which is exactly what the prov events exist for.

### D6 — Manual re-trigger: a force variant in the trigger module, surfaced twice

`forceReprofile(runtime, analysis)` beside `ensureProfileAtParity`, sharing its seams: reconcile → status
(`running` → refuse) → stage → seed → trigger; a trigger `"failed"` on a `failed` row takes the retry-claim +
`runDataProfile` path (harness barrel exports both). Surfaces: a command-palette entry ("Re-profile data") and a
keybound action in the profile details dialog via `useDialogBindings` with a footer hint (dialog keys never bind
esc; which-key documents the leader path only — the dialog hint documents the in-dialog key). Both surfaces
refuse pre-`ready` and on empty enumeration with an explanatory notice. Cortex parity: the manual retry route.

### D7 — Sidebar order is a pure reorder

Move the DATA PROFILE `<Section>` below ANALYSIS in `sidebar.tsx` (JSX order only; leader keys, click wiring,
and the live store are order-independent). Update the fixed-order comment (`sidebar.tsx:96`) and the design
gallery's sidebar exhibit if it snapshots section order.

## Risks / Trade-offs

- **[Enumeration and staging walks drift]** → single-source the walk (one function parameterized by
  "emit ids" vs "materialize"); the input-staging spec adds an equality scenario; a unit test staging vs
  enumerating the same fixture asserts set equality.
- **[Debounce swallows a final edit burst on quit]** → the debounce is short and fires on the trailing edge;
  a missed final check self-heals on the next open (the `ready` edge re-checks drift). Accepted.
- **[Clear races a concurrent trigger]** — clear's `IS DISTINCT FROM 'running'` guard and the trigger CAS are
  both single-statement; the worst interleaving (clear lands, stale trigger seeds again) re-seeds pending state
  whose next parity check re-clears (empty set) or re-triggers (non-empty). No wedged state. Accepted.
- **[Auto re-profile burns sandbox/model cost on churny edits]** → debounce coalesces bursts; the running skip
  serializes overlapping desires (one workflow at a time, drift re-checked at completion); no auto-retry of
  failures. Cost per genuine input change is the same as Cortex managed.
- **[NULL-status migration meets existing rows]** → `ALTER COLUMN … DROP NOT NULL` touches no data; every
  existing row keeps its status. Rollback = the code path stops writing NULL (no destructive migration).
- **[The completion watch double-fires with the ready/swap edges]** → the drift check is idempotent and cheap
  (enumerate + compare → skip); duplicate checks are harmless by construction rather than prevented.

## Migration Plan

Additive throughout. Harness rider ships first (function + migration + export + spec edit + tests), cli follows;
release binaries are unaffected (dev umbrella untouched; the TUI path is the product path). No data migration,
no rollback hazard beyond reverting commits.

## Open Questions

_None — the two knobs raised in exploration (set-drift only; auto-clear on empty with an info notice) were
decided with the user._
