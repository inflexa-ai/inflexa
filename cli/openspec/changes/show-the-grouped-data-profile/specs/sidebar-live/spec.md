## MODIFIED Requirements

### Requirement: The sidebar renders live ledger data with graceful degradation

The sidebar MUST source its DATA PROFILE and RUNS sections from the harness ledger, through the pool of the booted runtime. The sources are the data-profile status row and the newest runs of the analysis, never mock fixtures. Before the runtime is `ready`, the sections MUST render a muted placeholder, and no read runs. An unprofiled analysis renders "not profiled". A read failure renders an unavailable state. None of these states can crash or block the sidebar. Every state distinguishes itself by glyph and tone from the design system.

The RUNS section MUST render **every active run**, not only the newest. An active (non-terminal) run MUST render its own run block directly under its run row: the progress meter, `done/total`, and the bounded step window (the narrow windowed mount, `maxSteps` capped). The block does not show the name or tag heading again, because the run row above is the heading. A terminal run MUST render as a plain one-line row, and the terminal rows stay capped as before. The run id of the row keys the block. Thus the progress of one run under the row of a different run is not representable. The rail scrolls, thus its length tracks live work rather than history.

Live work MUST NOT come from a windowed listing. The runs listing caps at the newest few rows, ordered by start time, and it drops the OLDEST running run first. That run is exactly the long analysis that these surfaces keep visible. Thus the set of active runs MUST come from a separate, uncapped read. The two reads merge, thus a run outside the listing window is still listed and still tracked. The uncapped read is bounded by live concurrency, not by history. Its failure MUST degrade to the view of the listing alone, and it removes no run that the listing sees.

#### Scenario: A long-running run outside the listing window stays observable

- **WHEN** a run is still active but older than the newest N runs the listing returns
- **THEN** it is still listed, still tracked for progress, and still announces when it terminates

#### Scenario: A failed active read never subtracts coverage

- **WHEN** the uncapped active read fails while the listing succeeds
- **THEN** the section renders exactly what the listing alone would have shown

Runs and steps MUST carry a name rather than an opaque id wherever a name exists. A run MUST take the title of its plan, from the persisted plan. The fallback is the workflow name, then the id tail. The stored workflow name is identical on every row, and it identifies nothing. A step MUST take its plan-assigned name, with its step id as the fallback, and it MUST show the agent that owns it.

The rendered state of a step MUST keep the distinctions that the ledger records. A skipped step MUST be distinguishable from one that waits to start. A blocked step MUST surface the recorded reason, and it does not read as an ordinary failure. A retried step MUST show the retry.

The completed-profile line MUST report the size of the SCANNED TREE and the number of kinds the profiler grouped it into. It MUST NOT report the length of the `files` list of the profile. That list holds the individually described singletons, and the schema of the profiler caps it at 50, thus its length is a selection and never a total. The scanned total is `coverage.total`, which the harness computes from the file set. The sum of the kind counts is the fallback on a row that predates coverage, and the described-file count is the last resort on a row that predates kinds. A row that carries no kinds MUST NOT render a kind count of zero, because a zero asserts that the profiler found none.

The completed-profile line MUST show the absolute completed time (`toLocaleString()`, matching the details dialog), not a relative age. A profile is a durable record, referenced long after it ran. A bare `8h` forces the reader to do date arithmetic that the absolute time answers directly. The RUNS rows keep compact relative ages. An absolute timestamp on every run row would exceed the usable width of the rail, and each row would wrap. The SESSION created time is absolute for the same durable-record reason, per the sidebar requirement of `tui-layout`.

#### Scenario: Sections degrade before the runtime is ready

- **WHEN** the sidebar renders while the harness runtime is still booting
- **THEN** the DATA PROFILE and RUNS sections show muted placeholders and no ledger query runs

#### Scenario: Profile states render truthfully

- **WHEN** the analysis's ledger row is absent, running, completed, or failed
- **THEN** the DATA PROFILE section shows the matching state (not-profiled / profiling / completed with the scanned file count, the kind count, and the absolute completed time / failed with a one-line error)

#### Scenario: A grouped profile counts the tree, not the description

- **WHEN** a completed profile describes 2 files individually and groups 36 more into 2 kinds
- **THEN** the DATA PROFILE line reports the scanned total and the kind count, and it never reports the described count

#### Scenario: Real runs replace the mocks

- **WHEN** the analysis has runs in the ledger
- **THEN** the RUNS section lists the runs with their real status, name, and relative start time — and shows "no runs" when none exist

#### Scenario: Every active run shows its own progress

- **WHEN** two runs are active at once
- **THEN** each renders its own progress meter, `done/total`, and bounded step window under its own run row, with no repeated run name

#### Scenario: A finished run collapses to a row

- **WHEN** an active run reaches a terminal status
- **THEN** its block is replaced by a plain one-line row and the remaining active runs keep their blocks

#### Scenario: Runs and steps are named

- **WHEN** a run's plan carries a title and its steps carry names
- **THEN** the run row shows the plan title, and each step row shows its plan name and owning agent
- **AND** no row falls back to an id tail or a step slug while the name exists

#### Scenario: Blocked and skipped states stay distinct

- **WHEN** the step ledger holds a blocked step, a skipped step, and a pending step for a rendered run
- **THEN** the blocked step surfaces its recorded reason, and the skipped step is distinguishable from the pending one

### Requirement: Profile and runs details open from the sidebar

The DATA PROFILE and RUNS sections SHALL each open a details flow, both by mouse activation on the
section and by a leader keybinding (documented in which-key). The profile details view SHALL show
the ledger truth, in blocks: the lifecycle (status, timestamps, usage, and the error when failed), the
profile summary, the subject, the structure of the dataset, the described files, the quality findings,
and the seed-input count. The subject block SHALL carry the domain, the subtype, the organism with its
taxon id, its source and its confidence, the tissue, the cell type, the condition, the accessions, and
the experimental design. The structure block SHALL carry each kind with its count, its path pattern,
what one member represents, and the labels of the axes that vary across it, then each axis with its
cardinality and its example values, then the coverage. The file block SHALL name itself `described
files`, never `files`, and each entry SHALL carry the data type, the format, the row and column counts,
the tags, the warnings, and the metrics that the row holds. An explicit null organism SHALL render as a
finding, because the profiler looked and no input identified one. A block whose fields are all absent
SHALL contribute no lines, because a snapshot written before a field existed simply lacks that field.
The view scrolls, thus it SHALL show each fact that the row carries, and not a selection that fits one
viewport. Because a details view presents a durable, referenced record
(not a live fixed-width readout), its timestamps SHALL render as absolute local date-times
(`toLocaleString()`, the system locale), NOT relative ages: the profile details SHALL show absolute
`started` and `completed` lines plus a `duration` line (completed − started, via the shared
duration formatter) — for failed profiles too (the ledger stamps `completedAt` on failure), and a
still-running profile SHALL show its live elapsed time instead of a duration. The sidebar rail
itself keeps compact relative ages (see the rail requirement) — the absolute/relative split follows
the project's durable-record vs live-readout rule in `CLAUDE.md`.

The profile details view SHALL additionally offer the keybound re-profile action (per
`tui-harness-chat`), discoverable via the dialog's footer hint, active only when a re-profile can
start (runtime ready, inputs present, no profile running).

The RUNS flow SHALL be a picker → detail pair. Activating the RUNS section (click or keybind) SHALL
open a searchable runs picker — a `SelectDialog` over the analysis's runs fetched fresh at open
(newest-first, capped at 100; the cap SHALL be stated visibly when exactly 100 rows return, so
truncation is never silent). Picker rows SHALL show the run's short name, id tail, status, and
absolute started time. Selecting a run SHALL push a run-detail dialog OVER the picker (the picker
stays mounted beneath, so dismissing the detail returns to browsing). The run-detail dialog SHALL
show the run's metadata — status, absolute started/completed times, a duration via the shared
formatter (a still-running run shows elapsed time instead), and the error when failed — plus the
run's full step list (from the step ledger, fetched once at open) through the design system's run
block with no step window, including a failed-step state. Both dialogs SHALL follow the dialog
subsystem's rules (host-owned escape, cancel wiring, inert showcase) and SHALL be gallery-showcased.

#### Scenario: Profile details show the ledger truth

- **WHEN** the user activates the DATA PROFILE section (click or keybind) on a profiled analysis
- **THEN** a dialog shows the profile's status, timestamps, summary, subject, kinds, axes, coverage, described files, and quality findings

#### Scenario: The details view shows the structure of the dataset

- **WHEN** the profile carries kinds, axes, and coverage
- **THEN** the view lists each kind with its count and its path pattern, each axis with its cardinality, and the coverage of the scanned tree

#### Scenario: The details view shows what the data is about

- **WHEN** the profile carries a domain and an organism
- **THEN** the view shows the domain, the subtype, and the organism with its taxon id, its source, and its confidence

#### Scenario: An absent block contributes no lines

- **WHEN** the profile predates the kinds, the axes, and the quality assessment
- **THEN** the view shows no heading for them, and it shows every field that the row does carry

#### Scenario: Profile timestamps are absolute with a duration

- **WHEN** the profile details view opens on a completed (or failed) profile
- **THEN** the `started` and `completed` lines show absolute local date-times and a `duration` line shows completed − started via the shared formatter

#### Scenario: A running profile shows live elapsed time

- **WHEN** the profile details view opens while the profile is still running
- **THEN** the view shows the absolute `started` time and the elapsed time since it, with no `completed`/`duration` lines

#### Scenario: Re-profile fires from the details dialog

- **WHEN** the user presses the re-profile key in the profile details dialog on a completed profile
- **THEN** the re-profile starts and the dialog closes — the notice and the DATA PROFILE section carry the live outcome (the dialog is a point-in-time snapshot and does not track the ledger while open)

#### Scenario: Activating RUNS opens the searchable picker

- **WHEN** the user activates the RUNS section (click or keybind) on an analysis with runs
- **THEN** a `SelectDialog` lists the analysis's runs newest-first (fetched fresh, capped at 100) with short name, id tail, status, and absolute started time, filterable by typing

#### Scenario: Selecting a run opens its detail over the picker

- **WHEN** the user selects a run in the picker
- **THEN** a run-detail dialog opens showing status, absolute started/completed times, a duration (or elapsed for a running run), the error when failed, and the full step list with per-step state (done / running / failed / queued)
- **AND** dismissing the detail returns to the still-mounted picker

#### Scenario: The cap is visible, never silent

- **WHEN** the picker's fresh fetch returns exactly 100 runs
- **THEN** the picker states that only the newest 100 are listed

#### Scenario: Details views degrade pre-ready

- **WHEN** a details flow is opened before the runtime is ready
- **THEN** it renders the same muted not-ready state instead of querying
