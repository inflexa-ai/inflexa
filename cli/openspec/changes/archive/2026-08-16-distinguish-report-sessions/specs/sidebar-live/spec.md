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

The completed-profile line MUST show the absolute completed time (`toLocaleString()`, matching the details dialog), not a relative age. A profile is a durable record, referenced long after it ran. A bare `8h` forces the reader to do date arithmetic that the absolute time answers directly. The RUNS rows keep compact relative ages. An absolute timestamp on every run row would exceed the usable width of the rail, and each row would wrap. The SESSION created time is absolute for the same durable-record reason, per the sidebar requirement of `tui-layout`.

#### Scenario: Sections degrade before the runtime is ready

- **WHEN** the sidebar renders while the harness runtime is still booting
- **THEN** the DATA PROFILE and RUNS sections show muted placeholders and no ledger query runs

#### Scenario: Profile states render truthfully

- **WHEN** the analysis's ledger row is absent, running, completed, or failed
- **THEN** the DATA PROFILE section shows the matching state (not-profiled / profiling / completed with file count and the absolute completed time / failed with a one-line error)

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
