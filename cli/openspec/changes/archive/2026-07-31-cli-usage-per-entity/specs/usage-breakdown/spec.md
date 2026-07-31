## MODIFIED Requirements

### Requirement: The ledger is readable at the session, run, and step grains

The CLI SHALL provide read paths reporting an analysis's recorded consumption grouped by session, by run, and — within one run — by step. Each SHALL return per-quantity sums and a call count per group, and SHALL preserve the absent-means-not-reported rule: a quantity no row in a group reported SHALL read back as absent, never as zero.

The CLI SHALL additionally provide read paths for: the data profile's own totals; ONE session's totals INCLUDING the runs it launched; one session's consumption grouped by served model and by agent; and per-analysis totals across several analyses in one read, so a picker listing them does not issue a query per row.

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

#### Scenario: A session's totals can be read with its runs folded in

- **GIVEN** a conversation that launched a run, both stamped with the same thread
- **WHEN** the session's inclusive totals are read
- **THEN** they cover the conversation's calls and the run's together

#### Scenario: Several analyses' totals are read at once

- **GIVEN** a list of analyses to display side by side
- **WHEN** their totals are read
- **THEN** one query returns a total per analysis rather than one query per analysis

### Requirement: The grains partition the analysis total by where the work ran

A call SHALL be attributed to exactly one grain, following the frame it ran in: a chat turn's calls belong to its session, a run's calls belong to that run, a run step's calls additionally belong to that step, and the data profile's calls belong to the data-profile grain rather than to any run. A session's figures SHALL NOT include the runs it launched.

The data profile SHALL be excluded from the run grouping wherever runs are grouped. It is not a run: the id it is recorded under is a synthetic literal with no run-ledger row, no run listing shows it, and the sidebar has always treated the data profile and runs as separate entities — only the ledger's single run-id column conflates them, and a profile appearing among runs is a row a reader cannot cross-reference against anything.

The analysis headline SHALL remain the total over every call, so that the grains below it partition that total rather than overlapping it.

A call carrying neither a thread nor a run is possible — background and boot-time work runs under an analysis scope without either — so the grains SHALL account for it explicitly as an unattributed group rather than letting it fall out of the breakdown. Recorded consumption SHALL NOT be visible in the headline and absent from every grain beneath it: a figure that appears in a total but nowhere in its parts reads as a defect in the ledger, and hiding it is worse than naming it.

This partition is the reading the grain REPORTS use. A surface answering "what has this conversation cost" — the sidebar's session figure — folds a session's runs into it instead, and SHALL say which reading it shows. Both are legitimate and they differ by the whole of a run; the hazard is not that both exist but that both are called "session usage" without saying so.

#### Scenario: A run launched from a chat is not counted twice

- **GIVEN** a conversation that launched a run, and both grains displayed together
- **WHEN** the session and run figures are read
- **THEN** the run's tokens appear under the run and not also under the session

#### Scenario: The data profile does not appear among the runs

- **GIVEN** an analysis with one run and one completed data profile
- **WHEN** the run grain renders
- **THEN** only the run appears, and the profile's figures are reported as the data-profile grain

#### Scenario: The grains reconcile with the headline

- **GIVEN** an analysis with chat turns, runs, a data profile, and calls carrying neither a thread nor a run
- **WHEN** the session, run, data-profile, and unattributed figures are summed per quantity
- **THEN** they equal the analysis headline

#### Scenario: Work belonging to no session or run is still shown

- **GIVEN** an analysis whose only calls carry neither a thread nor a run
- **WHEN** the grains render
- **THEN** an unattributed group carries those figures rather than the breakdown appearing empty

### Requirement: Usage opens from the sidebar as a dialog over the local ledger

The sidebar's USAGE section SHALL be an activation point that opens a usage dialog, matching the affordance the DATA PROFILE and RUNS sections already provide. No new keybinding SHALL be added for it: the section click is the affordance those sibling sections already teach, and a chord can be added later against the live keymap rather than reserved speculatively here.

The dialog SHALL present the OPEN SESSION's consumption broken down by served model and by agent, matching the scope of the section that opens it. It SHALL NOT carry by-session, by-run, or by-step tables, and SHALL NOT drill from a run into its steps.

Those grains were removed because each now has an entity that reports it in place — the rail's session figure, each run row, each step in the run block, the data-profile section — and two sources for one number is how they come to disagree. A model and an agent are kept because neither is an entity anywhere in the interface: there is no model card and no agent card to hang a figure on, and there never will be, since neither is something the user creates or opens. Exhaustive cross-grain tables remain available through the `usage` command, which is the wide, scriptable, non-interactive medium where a full table belongs.

The dialog's HEADLINE SHALL use the labelled form of a token figure, and its grouping ROWS the compact form (`usage-figure-rendering`). The headline is the dialog's subject and has a full panel width to spend; a grouping row is one of many being compared down a column, where words would push the figures apart and make the comparison harder rather than clearer.

The headline's output quantity SHALL be aligned to the panel's trailing edge, with input at the leading edge. The two are peers and the reader is comparing them, so each belongs at an edge it can be found at without scanning. Splitting the row into two equal halves and letting each quantity sit at the start of its own half is NOT sufficient: it leaves the output figure floating near the middle of the panel, adjacent to nothing, reading as neither aligned nor deliberate. Quantities nested UNDER an arm stay aligned to that arm rather than to the edge, so the indent continues to read as an indent.

The dialog SHALL read only the local ledger and SHALL open with the harness runtime stopped. It SHALL NOT compute a single combined token figure at any grain: input and output are reported as two figures, with the remaining quantities available only as breakdowns of those two.

A read failure SHALL render an unavailable state inside the dialog rather than preventing it from opening.

#### Scenario: The dialog opens with the durable engine stopped

- **GIVEN** recorded usage and no running harness runtime
- **WHEN** the user activates the USAGE section
- **THEN** the dialog opens and shows the session's models and agents

#### Scenario: The dialog is scoped to the open session

- **GIVEN** an analysis with two conversations, each having used a different model
- **WHEN** the dialog opens on one of them
- **THEN** only that session's models appear

#### Scenario: The headline's two quantities sit at opposite edges

- **GIVEN** a session whose calls reported both an input and an output quantity
- **WHEN** the dialog renders
- **THEN** the input figure is at the panel's leading edge and the output figure at its trailing edge, neither floating mid-panel

#### Scenario: A nested quantity aligns to its arm, not to the edge

- **GIVEN** a headline whose output arm carries a nested quantity
- **WHEN** the dialog renders
- **THEN** that quantity is indented under its own arm rather than pushed to the panel edge

#### Scenario: No grain shows a summed token count

- **GIVEN** groups whose rows carry cache and reasoning counts
- **WHEN** any grain renders
- **THEN** each row shows an input figure and an output figure, with neither carrying the cache or reasoning counts added into it

#### Scenario: A failed read does not block the dialog

- **GIVEN** a ledger read that fails
- **WHEN** the dialog opens
- **THEN** it renders an unavailable state and remains dismissable

## ADDED Requirements

### Requirement: The data profile's run id comes from the harness, never a literal in the CLI

The identifier the CLI recognises data-profile usage rows by SHALL be imported from the harness, which authors it at the point it stamps the run frame. The CLI SHALL NOT write that string in its own source.

A copy is a silent coupling: the harness could rename the literal and nothing in the CLI would fail to compile or fail a test — the profile's rows would simply return to appearing as an unnamed run, which is the exact defect this change removes. Importing it makes the coupling a compile-time one, on the same reasoning that the ledger stores the harness's scope discriminant rather than assuming it.

#### Scenario: The recogniser is the harness's own value

- **WHEN** the CLI partitions data-profile rows out of the run grouping
- **THEN** it compares against the identifier exported by the harness, not a string written in the CLI
