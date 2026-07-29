## MODIFIED Requirements

### Requirement: The data profile auto-triggers at parity

The TUI SHALL keep the data profile at managed parity with the analysis's **current input set**, not
merely trigger it once. The parity check SHALL run when the runtime reaches `ready`, after an
analysis swap, on input mutations (the `prov.input_added` / `prov.input_removed` bus events every
input-edit surface emits — debounced and coalesced per analysis, since batch edits emit bursts), and
once when a profile it observed `running` reaches a terminal state — `completed` **or** `failed`, so
that work deferred by the running-skip is released on either outcome.

Parity SHALL be judged on the input files' **drift signatures** — `(fileId, size, mtimeMs)`, enumerated
read-only per `input-staging` (no content hashing, no tree writes) — not on their identities alone, so
that editing an input file's bytes in place at the same path re-profiles.

**Materialization SHALL NOT be conditioned on the data-profile lifecycle.** With a non-empty input set
and no profile actively running, the check SHALL materialize the current input set whenever it is not
already materialized (per `input-staging`'s already-materialized predicate), *before* and independently
of any decision about whether to profile. No profile ledger state other than `running` SHALL suppress
materialization. A `running` profile remains the sole suppressor, because staging reconcile-deletes a
tree a live sandbox is reading.

The check SHALL then decide profiling separately, comparing the enumerated set against the signatures
the completed profile recorded (`result.inputFiles`), and act:

- no profile, or a `pending` row, with a non-empty input set → stage → seed → trigger (the same
  sequence as the profile command), surfacing the start as a notice;
- a completed profile whose recorded signature set equals the current set → silent skip, and staging is
  skipped too (a completed profile at parity implies its set is materialized);
- a completed profile whose recorded signature set differs → re-stage → seed → trigger (the trigger's
  completed-row CAS restarts it), surfacing a re-profiling notice;
- a completed profile that records **no** signatures (a null result, or one written before the
  signature field existed) → treated as drifted and re-profiled, never trusted;
- an empty input set while a profile exists → clear the profile through the harness ledger op so
  the sidebar honestly returns to "not profiled", surfacing an informational notice;
- an empty input set with no profile → silent skip;
- a `running` profile → skip entirely, staging included (the terminal-state edge re-runs the check, so
  edits made mid-profile are not lost until the next open);
- a `failed` profile whose input set is **unchanged** since that failed attempt → materialize if needed,
  then no auto-retry (managed parity: retrying a failure against the same inputs is deliberate) — the
  manual re-trigger and the dev profile command cover it;
- a `failed` profile whose input set **changed** since that failed attempt → materialize, then claim the
  `failed → running` transition and run, surfacing a re-profiling notice. A failure recorded against a
  different input set is not evidence about the current one. This cannot loop unattended: a retry is
  reachable only through a fresh input-set change, so a persistently failing profile still requires user
  action to re-run.

Every entry into the profile lifecycle — the parity edges above and the deliberate manual re-profile —
SHALL be **serialized**: at most one may run its materialize → seed → trigger sequence at a time, and one
arriving while another runs SHALL queue behind it rather than be dropped, because the edges fire
precisely because state changed. Serialization is required for two reasons the ledger CAS cannot
supply, since it runs only after staging: concurrent `stageInputs` calls on one workspace tree race the
tree-reconciliation delete, and a concurrent clear can null `seed_input_file_ids` between another
drive's seed write and its trigger.

The check's outcome SHALL report the materialization fact independently of the profile decision, so a
caller can distinguish "inputs are on disk but profiling did not run" from "nothing happened". That fact
SHALL be true whenever the check finished with the current input set materialized — whether this check
staged it, or found it already materialized, or skipped staging because a completed profile at parity
implies it — and false when the check did not establish materialization, namely a staging failure, an
empty input set, or the `running` skip where it deliberately does not look.

Materialization is a precondition for seeding, so a staging failure SHALL surface as a check failure
carrying its reason, and the profile decision SHALL NOT be reached — no seed is written and no trigger
is dispatched against a tree that did not materialize.

Chat SHALL NOT be gated on profile state. Triggers and clears SHALL be non-blocking and SHALL poke
the sidebar's live store (these are the ledger edges outside its own refresh triggers). A check
whose analysis was swapped away while it was in flight SHALL drop both its side effects and its
notice.

#### Scenario: First open of an analysis with inputs profiles it

- **WHEN** the TUI opens an analysis that has inputs but has never been profiled
- **THEN** the profile workflow is triggered without blocking the chat, and a notice reports it started

#### Scenario: Chat is never blocked on the profile

- **WHEN** the parity check triggers a profile workflow on chat open
- **THEN** the chat accepts turns immediately and the check returns as soon as the trigger is dispatched

#### Scenario: Chat is usable while the profile runs

- **WHEN** the profile workflow is still running
- **THEN** a submitted message runs a normal turn (no gate, no refusal)

#### Scenario: Adding an input to a profiled analysis re-profiles it

- **WHEN** the user adds an input (file picker or remove/add commands) to an analysis whose profile completed, while the runtime is ready
- **THEN** the drift check re-triggers the profile without further user action, a re-profiling notice appears, and the sidebar shows the profile running

#### Scenario: A failed profile does not block materialization of new inputs

- **GIVEN** an analysis whose data-profile row is `failed`
- **WHEN** an input is registered and a parity edge fires
- **THEN** the new input SHALL be staged into the workspace tree and readable by the workspace tools
- **AND** the check's outcome SHALL report that materialization happened

#### Scenario: A failed profile is retried once its input set changes

- **GIVEN** an analysis whose data-profile row is `failed`, recorded against a given input set
- **WHEN** the input set changes and a parity edge fires
- **THEN** the check SHALL claim the `failed → running` transition and run the profile, surfacing a re-profiling notice

#### Scenario: A failed profile is not retried while its input set is unchanged

- **GIVEN** an analysis whose data-profile row is `failed`
- **WHEN** a parity edge fires with the input set unchanged since that failure
- **THEN** no profile run SHALL be started, and the failure SHALL be left for the deliberate re-trigger

#### Scenario: A run that fails still releases work deferred by the running-skip

- **GIVEN** inputs changed while a profile was running, so the live check skipped
- **WHEN** that profile reaches `failed` rather than `completed`
- **THEN** the terminal-state edge SHALL re-run the check, materializing the changed input set

#### Scenario: A settled analysis at parity does not re-stage

- **WHEN** a parity edge fires on a completed profile whose recorded signature set equals the current one
- **THEN** the check SHALL NOT content-hash or rewrite the staged tree

#### Scenario: An unchanged failed row does not re-stage

- **WHEN** a parity edge fires on a `failed` row whose input set is already materialized
- **THEN** the check SHALL NOT content-hash or rewrite the staged tree
- **AND** the outcome SHALL still report the input set as materialized

#### Scenario: A path that profiles always stages

- **WHEN** the check decides to seed and trigger a profile
- **THEN** it SHALL stage first even if the tree is already current, because the seed carries a manifest of content hashes that only staging produces

#### Scenario: A staging failure stops before the profile decision

- **WHEN** materialization fails during a parity check
- **THEN** the check SHALL report failure with the staging reason
- **AND** no seed SHALL be written and no profile trigger SHALL be dispatched

#### Scenario: A file added inside a directory input is drift

- **WHEN** a new data file appears inside a directory that is enrolled as a single directory input, and any parity edge fires
- **THEN** the enumerated signature set differs from the profiled set and the profile re-triggers

#### Scenario: An in-place content edit re-profiles

- **WHEN** an input file's bytes change at the same path (altering its size or mtime) and a parity edge fires
- **THEN** the check SHALL observe drift and re-trigger the profile, rather than reporting the analysis already profiled

#### Scenario: A completed row without signatures re-profiles once

- **WHEN** the ledger's completed result predates the drift-signature field
- **THEN** the check SHALL treat it as drifted and re-profile

#### Scenario: Removing every input clears the profile

- **WHEN** the user removes the last input of an analysis with a completed profile
- **THEN** the profile is cleared, the DATA PROFILE section returns to "not profiled", and an informational notice explains why

#### Scenario: Edits during a running profile are caught at completion

- **WHEN** inputs change while a profile is running
- **THEN** the live check skips (already running), and when that profile completes the check re-runs and re-triggers on the drift

#### Scenario: A running profile suppresses staging

- **WHEN** an input mutation edge fires while a profile is `running`
- **THEN** the check SHALL NOT stage, so the tree the live sandbox is reading is not reconcile-deleted underneath it

#### Scenario: Two edges firing together do not race the workspace tree

- **WHEN** an input-mutation edge and a profile-completion edge fire while a parity check is already staging
- **THEN** the later drives SHALL run strictly after the first completes
- **AND** `stageInputs` SHALL never execute concurrently for one analysis

#### Scenario: A clear cannot wipe a concurrent drive's seed

- **WHEN** one drive observes an emptied input set and clears the ledger while another drive is seeding a non-empty set
- **THEN** the two SHALL NOT interleave, and no drive SHALL report a start failure caused by the other's clear
