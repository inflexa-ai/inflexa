## ADDED Requirements

### Requirement: The ledger is readable at the session, run, and step grains

The CLI SHALL provide read paths reporting an analysis's recorded consumption grouped by session, by run, and — within one run — by step. Each SHALL return per-quantity sums and a call count per group, and SHALL preserve the absent-means-not-reported rule: a quantity no row in a group reported SHALL read back as absent, never as zero.

These read paths SHALL require no schema change. Every grouping column is already stored, and every query SHALL be constrained to one analysis so the existing scope index remains the selective one.

#### Scenario: An analysis's sessions are reported separately

- **GIVEN** an analysis whose calls span two conversation threads
- **WHEN** the session grain is read
- **THEN** each thread appears as its own group with its own figures and call count

#### Scenario: A run's steps are reported within that run

- **GIVEN** a run whose calls span three steps
- **WHEN** the step grain is read for that run
- **THEN** each step appears as its own group, and steps of other runs do not appear

#### Scenario: A group that reported nothing is not reported as zero

- **GIVEN** a run whose provider reported no usage on any call
- **WHEN** the run grain is read
- **THEN** the run appears with its call count and absent figures, distinguishable from a run that reported zero

### Requirement: The grains partition the analysis total by where the work ran

A call SHALL be attributed to exactly one grain, following the frame it ran in: a chat turn's calls belong to its session, a run's calls belong to that run, and a run step's calls additionally belong to that step. A session's figures SHALL NOT include the runs it launched.

The analysis headline SHALL remain the total over every call, so that the grains below it partition that total rather than overlapping it.

A call carrying neither a thread nor a run is possible — background and boot-time work runs under an analysis scope without either — so the grains SHALL account for it explicitly as an unattributed group rather than letting it fall out of the breakdown. Recorded consumption SHALL NOT be visible in the headline and absent from every grain beneath it: a figure that appears in a total but nowhere in its parts reads as a defect in the ledger, and hiding it is worse than naming it.

#### Scenario: A run launched from a chat is not counted twice

- **GIVEN** a conversation that launched a run, and both grains displayed together
- **WHEN** the session and run figures are read
- **THEN** the run's tokens appear under the run and not also under the session

#### Scenario: The grains reconcile with the headline

- **GIVEN** an analysis with chat turns, runs, and calls carrying neither
- **WHEN** the session, run, and unattributed figures are summed per quantity
- **THEN** they equal the analysis headline

#### Scenario: Work belonging to no session or run is still shown

- **GIVEN** an analysis whose only calls carry neither a thread nor a run
- **WHEN** the grains render
- **THEN** an unattributed group carries those figures rather than the breakdown appearing empty

### Requirement: Usage opens from the sidebar as a dialog over the local ledger

The sidebar's USAGE section SHALL be an activation point that opens a usage dialog, matching the affordance the DATA PROFILE and RUNS sections already provide. No new keybinding SHALL be added for it: the section click is the affordance those sibling sections already teach, and a chord can be added later against the live keymap rather than reserved speculatively here.

The dialog SHALL present the analysis headline and the breakdowns by session, by run, by served model, and by agent, and SHALL drill from a run into that run's steps. Steps SHALL NOT be a top-level grain, because a step id is meaningful only within its run.

The dialog SHALL read only the local ledger and SHALL open with the harness runtime stopped. It SHALL NOT compute a single combined token figure at any grain: input and output are reported as two figures, with the remaining quantities available only as breakdowns of those two.

A read failure SHALL render an unavailable state inside the dialog rather than preventing it from opening.

#### Scenario: The dialog opens with the durable engine stopped

- **GIVEN** recorded usage and no running harness runtime
- **WHEN** the user activates the USAGE section
- **THEN** the dialog opens and shows the headline and every populated grain

#### Scenario: A run drills into its steps

- **WHEN** the user selects a run in the dialog
- **THEN** that run's steps are shown with their own figures, and other runs' steps are not

#### Scenario: No grain shows a summed token count

- **GIVEN** groups whose rows carry cache and reasoning counts
- **WHEN** any grain renders
- **THEN** each row shows an input figure and an output figure, with neither carrying the cache or reasoning counts added into it

#### Scenario: A failed read does not block the dialog

- **GIVEN** a ledger read that fails
- **WHEN** the dialog opens
- **THEN** it renders an unavailable state and remains dismissable

### Requirement: A grain row is identified without requiring the durable engine

A session or run row SHALL be identified by the same six-character id tail the sidebar's run surfaces already use, so one id reads identically wherever the app prints it. When two rows in one list would render the same tail, every colliding row SHALL extend to the shortest length that tells them apart, so a list never shows one label for two things.

The id SHALL always be rendered. A human-readable name, when the application already holds one, SHALL be shown IN ADDITION to the id rather than replacing it — a row must read the same whether the runtime is cold or warm, and a label that appears and disappears with boot state is not an identity. Fetching a name SHALL NOT be attempted, and its absence SHALL never block a row from rendering or delay the dialog.

Rows SHALL be ordered by input tokens descending, then output tokens descending, then call count descending — a lexicographic order over named quantities. A single "total spend" ordering SHALL NOT be constructed, since that requires the combined figure this capability forbids.

#### Scenario: Two rows sharing an id tail are told apart

- **GIVEN** two runs in one analysis whose ids share their last six characters
- **WHEN** the run grain renders
- **THEN** both rows extend to the shortest length that distinguishes them

#### Scenario: A run with no loaded label still renders

- **GIVEN** a run whose name is not held in memory
- **WHEN** the run grain renders
- **THEN** the row renders with its id tail and its figures

#### Scenario: A row reads the same cold or warm

- **GIVEN** a run whose name is held in memory on one open and not on another
- **WHEN** the run grain renders in each case
- **THEN** the id tail is present and identical both times, the name appearing only as additional text

#### Scenario: The largest consumer is first

- **GIVEN** several runs of differing consumption
- **WHEN** the run grain renders
- **THEN** the largest appears first

### Requirement: Each usage grain is a separately classified subcommand

The `usage` command SHALL expose the session, run, and step grains as subcommands rather than as options on the existing report, so each grain carries its own agent-policy classification and a grain added later cannot widen an existing command's safe-flag allowlist.

Every grain SHALL be read-only and SHALL NOT write. Each new subcommand's classification SHALL be confirmed with the user before it is registered.

#### Scenario: A grain subcommand writes nothing

- **GIVEN** an analysis with recorded usage
- **WHEN** any usage grain subcommand runs
- **THEN** it prints its report, the ledger is unchanged, and the analysis's anchor heartbeat is unchanged

#### Scenario: A grain with no recorded usage says so

- **WHEN** a grain subcommand runs for an analysis with no calls at that grain
- **THEN** it reports that none were recorded rather than printing an empty table or zeroed figures
