# tui-harness-chat Delta

## MODIFIED Requirements

### Requirement: The data profile auto-triggers at parity

The TUI SHALL keep the data profile at managed parity with the analysis's **current input set**, not
merely trigger it once. The parity check SHALL run when the runtime reaches `ready`, after an
analysis swap, on input mutations (the `prov.input_added` / `prov.input_removed` bus events every
input-edit surface emits — debounced and coalesced per analysis, since batch edits emit bursts), and
once when a profile it observed `running` completes. The check SHALL compare the analysis's current
input identity set (the staging `fileId` derivation, enumerated read-only per `input-staging` — no
content hashing, no tree writes) against the completed profile's recorded `inputFileIds`, and act:

- no profile, or a `pending` row, with a non-empty input set → stage → seed → trigger (the same
  sequence as the profile command), surfacing the start as a notice;
- a completed profile whose recorded set equals the current set → silent skip;
- a completed profile whose recorded set differs → re-stage → seed → trigger (the trigger's
  completed-row CAS restarts it), surfacing a re-profiling notice;
- an empty input set while a profile exists → clear the profile through the harness ledger op so
  the sidebar honestly returns to "not profiled", surfacing an informational notice;
- an empty input set with no profile → silent skip;
- a `running` profile → skip (the completion edge re-runs the check, so edits made mid-profile are
  not lost until the next open);
- a `failed` profile → no auto-retry (managed parity: retrying a failure is deliberate) — the
  manual re-trigger and the dev profile command cover it.

Chat SHALL NOT be gated on profile state. Triggers and clears SHALL be non-blocking and SHALL poke
the sidebar's live store (these are the ledger edges outside its own refresh triggers). A check
whose analysis was swapped away while it was in flight SHALL drop both its side effects and its
notice.

#### Scenario: First open of an analysis with inputs profiles it

- **WHEN** the TUI opens an analysis that has inputs but has never been profiled
- **THEN** the profile workflow is triggered without blocking the chat, and a notice reports it started

#### Scenario: Chat is usable while the profile runs

- **WHEN** the profile workflow is still running
- **THEN** a submitted message runs a normal turn (no gate, no refusal)

#### Scenario: Adding an input to a profiled analysis re-profiles it

- **WHEN** the user adds an input (file picker or remove/add commands) to an analysis whose profile completed, while the runtime is ready
- **THEN** the drift check re-triggers the profile without further user action, a re-profiling notice appears, and the sidebar shows the profile running

#### Scenario: A file added inside a directory input is drift

- **WHEN** a new data file appears inside a directory that is enrolled as a single directory input, and any parity edge fires
- **THEN** the enumerated identity set differs from the profiled set and the profile re-triggers

#### Scenario: Removing every input clears the profile

- **WHEN** the user removes the last input of an analysis with a completed profile
- **THEN** the profile is cleared, the DATA PROFILE section returns to "not profiled", and an informational notice explains why

#### Scenario: Edits during a running profile are caught at completion

- **WHEN** inputs change while a profile is running
- **THEN** the live check skips (already running), and when that profile completes the check re-runs and re-triggers on the drift

#### Scenario: In-place content edits do not auto-re-profile

- **WHEN** the bytes of an existing input file change with no input-set operation
- **THEN** no automatic re-profile fires (identity is path-derived, managed parity) — the manual re-trigger is the covered path

## ADDED Requirements

### Requirement: The user can re-trigger profiling manually

The TUI SHALL offer a deliberate re-profile action — a command-palette entry and a keybound action
inside the DATA PROFILE details dialog (per `sidebar-live`) — that forces the stage → seed → trigger
sequence regardless of drift: a completed row restarts through the trigger's CAS; a `failed` row is
retry-claimed and started (the retry-claim + run path the profile command proves); a `running`
profile SHALL refuse with a notice and start nothing. Outcomes surface as notices and poke the
sidebar's live store. When a re-profile cannot start, each surface degrades in its own idiom: the
palette entry refuses with an explanatory notice (before the runtime is `ready`, or on an analysis
with no resolvable inputs), while the dialog action is simply not offered — no footer hint, no
binding (per `sidebar-live`).

#### Scenario: Re-profile restarts a completed profile

- **WHEN** the user invokes "Re-profile data" on an analysis whose profile completed — drifted or not
- **THEN** the profile workflow restarts, a notice reports it, and the sidebar shows it running

#### Scenario: Re-profile recovers a failed profile

- **WHEN** the user invokes the re-profile action on an analysis whose profile status is `failed`
- **THEN** the failed row is retry-claimed, the workflow starts, and the failure state clears from the sidebar

#### Scenario: Re-profile while running refuses

- **WHEN** the user invokes the re-profile action while a profile is running
- **THEN** a notice says a run is already in progress and no duplicate workflow starts
