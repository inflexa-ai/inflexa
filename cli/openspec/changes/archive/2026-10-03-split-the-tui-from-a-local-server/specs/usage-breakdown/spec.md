## MODIFIED Requirements

### Requirement: Usage opens from the sidebar as a dialog over the local ledger

The sidebar's USAGE section SHALL be an activation point that opens a usage dialog, matching the affordance the DATA PROFILE and RUNS sections already provide. No new keybinding SHALL be added for it: the section click is the affordance those sibling sections already teach, and a chord can be added later against the live keymap rather than reserved speculatively here.

The dialog SHALL present the OPEN SESSION's consumption broken down by served model and by agent, matching the scope of the section that opens it. It SHALL NOT carry by-session, by-run, or by-step tables, and SHALL NOT drill from a run into its steps.

Those grains were removed because each now has an entity that reports it in place — the rail's session figure, each run row, each step in the run block, the data-profile section — and two sources for one number is how they come to disagree. A model and an agent are kept because neither is an entity anywhere in the interface: there is no model card and no agent card to hang a figure on, and there never will be, since neither is something the user creates or opens. Exhaustive cross-grain tables remain available through the `usage` command, which is the wide, scriptable, non-interactive medium where a full table belongs.

The dialog's HEADLINE SHALL use the labelled form of a token figure, and its grouping ROWS the compact form (`usage-figure-rendering`). The headline is the dialog's subject and has a full panel width to spend; a grouping row is one of many being compared down a column, where words would push the figures apart and make the comparison harder rather than clearer.

The headline's output quantity SHALL be aligned to the panel's trailing edge, with input at the leading edge. The two are peers and the reader is comparing them, so each belongs at an edge it can be found at without scanning. Splitting the row into two equal halves and letting each quantity sit at the start of its own half is NOT sufficient: it leaves the output figure floating near the middle of the panel, adjacent to nothing, reading as neither aligned nor deliberate. Quantities nested UNDER an arm stay aligned to that arm rather than to the edge, so the indent continues to read as an indent.

The dialog SHALL read only the local ledger, through the usage route of the local server (`GET {A}/usage` with the thread and one grouping). That route reads SQLite only and needs no harness runtime, thus the dialog SHALL open while the runtime of the server is still starting or failed to boot. It SHALL NOT compute a single combined token figure at any grain: input and output are reported as two figures, with the remaining quantities available only as breakdowns of those two.

A read failure SHALL render an unavailable state inside the dialog rather than preventing it from opening.

#### Scenario: The dialog opens with the durable engine stopped

- **GIVEN** recorded usage and a local server whose harness runtime is not ready
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
