## ADDED Requirements

### Requirement: The panel aborts the focused run behind a confirmation

The panel MUST give an abort action for the run that it shows. The action MUST be live only while the panel is visible and its focused subject is a run. A data profile has no abort, because the run canceler cancels analysis runs only.

The action MUST first open a confirmation in the danger tone. The confirmation MUST name the run, and its default choice MUST be the choice that keeps the run. A declined or dismissed confirmation MUST change nothing.

A confirmed abort MUST cancel the run that the confirmation named. The panel focus can move while the confirmation is open, for example when that run ends and the panel advances. The abort MUST NOT go to the subject that the panel shows at the time of the confirmation.

The panel MUST report what the cancel really did:

- When the cancel changed the run to `canceled`, the run-completion notice MUST announce it. The TUI MUST read the runs again at once, thus the notice and the panel advance do not wait for the next poll. If the runs that the TUI reads again do not include the run, the completion watcher cannot see it. Then the TUI MUST announce the cancel itself.
- When the cancel changed the run to `canceled` and each ledger settled, the TUI MUST NOT show a second notice for the same abort.
- When the cancel changed the run to `canceled` but a ledger did not settle, the TUI MUST also show a warning notice. The notice MUST name each ledger that did not settle (the step rows, the charge, or the mandate).
- When the run reached a terminal status before the cancel, the TUI MUST show a notice that the run already finished, with that status. It MUST NOT claim an abort.
- When the cancel stopped the workflow but the run row did not change to a terminal status, the TUI MUST show an error notice that says that the run row did not settle. It MUST NOT say that the run already finished.
- When the cancel request fails, the TUI MUST show an error notice that gives the cause. Then the TUI MUST read the runs again, because the cancel can take effect before the failure.

While the cancel request of a run is open, the action MUST NOT open a second confirmation for that run. This rule applies to each run separately: an open request for one run does not stop the abort of a different run.

While the panel shows a run, its legend MUST name the abort chord with the chords that advance and dismiss the panel. The legend sheds the abort chord together with the other chords, as the legend ladder sets. The legend of a profile MUST NOT name the abort chord.

#### Scenario: A confirmed abort cancels the run

- **GIVEN** the panel shows a running run
- **WHEN** the user pushes the abort chord and confirms
- **THEN** the TUI cancels that run, and the run-completion notice announces it as canceled
- **AND** the panel advances to a different active subject, or takes no rows when none remains

#### Scenario: A declined confirmation changes nothing

- **WHEN** the user pushes the abort chord and then chooses to keep the run, or dismisses the confirmation
- **THEN** no cancel is sent, and the run continues

#### Scenario: The safe choice is the default

- **WHEN** the confirmation opens
- **THEN** it renders in the danger tone, names the run, and the active choice keeps the run

#### Scenario: A run that finished during the confirmation is reported as finished

- **GIVEN** the user opened the confirmation for a run
- **WHEN** the run completes before the user confirms, and the user then confirms
- **THEN** the TUI shows a notice that the run already finished, with its status
- **AND** no notice says that the run was aborted

#### Scenario: The abort goes to the named run

- **GIVEN** two runs are active and the user opened the confirmation for the first
- **WHEN** the panel advances to the second run before the user confirms
- **THEN** the confirmed abort cancels the first run, and the second run continues

#### Scenario: A failed cancel is reported

- **WHEN** the cancel request fails
- **THEN** the TUI shows an error notice that gives the cause
- **AND** the TUI reads the runs again, thus the panel and the rail show the real status of the run

#### Scenario: A ledger that did not settle is reported

- **WHEN** the cancel changes the run to `canceled`, but the result shows that the step rows did not settle
- **THEN** the run-completion notice announces the run as canceled
- **AND** the TUI shows a warning notice that names the step rows as not settled

#### Scenario: A run row that did not settle is not reported as finished

- **WHEN** the cancel result has `outcome: "canceled"` and the status `running`, because the write of the run row failed
- **THEN** the TUI shows an error notice that says that the run row did not settle
- **AND** no notice says that the run already finished

#### Scenario: A canceled run outside the refreshed list is still announced

- **GIVEN** the canceled run is not in the runs that the TUI reads again, because newer runs fill the list
- **WHEN** the cancel changes the run to `canceled`
- **THEN** the TUI shows a notice that the run was canceled

#### Scenario: A profile has no abort

- **WHEN** the panel shows a data profile and the user pushes the abort chord
- **THEN** no confirmation opens, and the profile continues

#### Scenario: The legend names the abort chord for a run only

- **WHEN** the panel shows a run at a width that fits the full legend
- **THEN** the legend names the abort chord beside the chords that advance and dismiss the panel
- **AND** when the panel shows a profile, the legend does not name the abort chord

#### Scenario: A pending abort does not open a second confirmation

- **GIVEN** the user confirmed the abort of a run, and the cancel request is still open
- **WHEN** the user pushes the abort chord again for that run
- **THEN** no second confirmation opens
