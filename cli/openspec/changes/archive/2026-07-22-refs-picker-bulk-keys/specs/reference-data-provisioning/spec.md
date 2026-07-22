## MODIFIED Requirements

### Requirement: Reference commands expose install, verification, and path operations

The CLI SHALL provide `inflexa refs list`, `inflexa refs download [ids...]`, `inflexa refs verify [ids...]`, and `inflexa refs path`. Interactive download with no ids SHALL offer the per-dataset picker directly — the grouped listing of every dataset being offered, opening with nothing selected, so narrowing a selection never requires deselection. The picker SHALL provide bulk-selection keys that replace the current selection: one selecting every offered dataset, one clearing the selection, and one selecting the recommended subset of the offered set. The recommended key SHALL have no effect, rather than clearing the selection, when no offered dataset is recommended. The picker SHALL display the keys it accepts, and SHALL keep the recommended key displayed when the offered set carries no recommendation, so a successful prior install never reads as a missing option. Where that emptiness is caused by recommended datasets already being installed, the displayed key SHALL name that cause and the number of them; otherwise it SHALL state only that none are offered. Cancelling the picker SHALL be treated as a cancellation, transferring nothing. Before transfer, download SHALL show the missing size and require confirmation unless explicit non-interactive consent is present. Verify SHALL hash active managed files against their receipt and SHALL report missing, modified, and valid states without modifying them, naming for each file which guarantee was checked — the catalog's checksum for a `pinned` file, the checksum recorded at install for an `unpinned` one.

`inflexa refs download --force` SHALL re-fetch and re-activate a dataset even when its active install is intact. This is the supported way to refresh an `unpinned` dataset, whose upstream may have moved on in a way no local inspection can detect. Interactive `refs download` with no ids SHALL offer only datasets that are not already installed and intact, except under `--force`, where every catalog dataset SHALL be offered because a forced run re-fetches an intact install.

#### Scenario: Interactive selection shows cost before consent

- **WHEN** an interactive user selects datasets in the picker
- **THEN** the CLI shows the combined missing download size and begins transfer only after confirmation

#### Scenario: The picker starts from nothing

- **WHEN** an interactive user is offered the per-dataset picker
- **THEN** no dataset is preselected, and confirming without touching anything selects nothing and transfers nothing

#### Scenario: A bulk key replaces the whole selection

- **WHEN** an interactive user presses the select-everything key and then the clear key
- **THEN** each keystroke replaces the selection outright, leaving every offered dataset selected and then none of them, and ordinary per-dataset and per-group toggling still applies on top

#### Scenario: The recommended key is inert rather than destructive

- **WHEN** an interactive user has a selection and presses the recommended key while no offered dataset is recommended
- **THEN** the selection is left untouched

#### Scenario: An empty recommended key names the install that emptied it

- **WHEN** the offered set carries no recommendation because the recommended datasets are already installed
- **THEN** the displayed recommended key names that cause and how many of them are installed, counting the recommended installs rather than every install

#### Scenario: An offer that never had a recommendation says only that

- **WHEN** the offered set carries no recommendation and no recommended dataset is installed either
- **THEN** the displayed recommended key states only that none are offered, claiming no install that did not happen

#### Scenario: Cancelling the picker transfers nothing

- **WHEN** an interactive user cancels the picker
- **THEN** the command treats it as a declined selection, activates no dataset, and reports the cancellation

#### Scenario: A forced interactive download offers intact datasets

- **WHEN** an interactive user runs `refs download --force` with no ids
- **THEN** every catalog dataset is offered, including installed and intact ones, because the run re-fetches them

#### Scenario: Verification detects manual damage

- **WHEN** an active managed file has been edited or removed
- **THEN** `inflexa refs verify` reports the affected dataset and file as invalid, names the repair command, exits non-zero, and changes no bytes

#### Scenario: A mutable upstream is refreshed on request

- **WHEN** an `unpinned` dataset is installed and intact, and the user runs `refs download <id> --force`
- **THEN** the CLI re-fetches from the upstream and re-activates, replacing the receipt with the newly observed digests

### Requirement: Setup reuses the reference download handler

Interactive `inflexa setup` SHALL deliberately create the reference-store and `user/` directories, inspect catalog installation state, and offer missing or updateable datasets with their sizes through the same headless download operation used by `inflexa refs download`. The offer SHALL be the per-dataset picker over the datasets setup is actually offering — the missing or updateable ones — so an intact dataset is never re-offered and the select-everything key never means "everything already installed". The recommended key SHALL select the recommended datasets within that offered set.

Before the picker, setup SHALL state how many datasets are already installed and intact and therefore absent from the listing.

Setup SHALL also state how references can be obtained later: by running `inflexa refs download` for a dataset, or by asking the agent in chat, which proposes that same command for the user's approval. That statement SHALL remain true of the shipped command surface, and SHALL be presented where it can inform the choice rather than only after an empty one. Where the terminal is wide enough to carry it without squeezing the listing below a usable width, it SHALL be presented alongside the listing so it remains visible as the listing scrolls; otherwise it SHALL be presented above the listing. It SHALL carry the same wording in either presentation, and SHALL NOT be repeated once a selection is made.

Declining or selecting nothing SHALL continue setup. A selected installation failure SHALL fail setup visibly.

Headless setup SHALL download no reference bytes unless dataset ids and non-interactive consent are explicit. Without them it SHALL print the reference-store path and an actionable `inflexa refs download` command and continue.

#### Scenario: Setup and explicit command share one installer

- **WHEN** setup installs a selected dataset
- **THEN** it produces the same managed layout, verification, activation, and receipt as `inflexa refs download` for that id

#### Scenario: The picker covers only what setup is offering

- **WHEN** an interactive user presses the select-everything key while some catalog datasets are already installed and intact
- **THEN** the plan contains only the missing or updateable datasets, and the already-installed ones are not re-fetched

#### Scenario: Setup names what the picker omits

- **WHEN** an interactive user reaches the reference step with datasets already installed and intact
- **THEN** setup states how many are installed and therefore not listed

#### Scenario: How to get references later is stated before the choice

- **WHEN** an interactive user reaches the reference step
- **THEN** setup tells them, before they choose, that they can download a dataset later with the reference download command, or ask the agent in chat, which proposes that command for their approval

#### Scenario: The later-download statement adapts to the terminal width

- **WHEN** the terminal is wide enough to carry the statement beside the listing without squeezing it below a usable width
- **THEN** the statement is shown alongside the listing and stays visible while the listing scrolls, and on a narrower terminal the same wording is shown above the listing instead

#### Scenario: Headless setup does not silently download

- **WHEN** setup runs without a TTY and without explicit reference ids and consent
- **THEN** it downloads nothing, prints how to install references later, and continues

#### Scenario: Explicit ids skip the picker

- **WHEN** setup runs with explicit reference dataset ids supplied on the command line
- **THEN** no picker is offered, and the named datasets are the plan, subject to the same consent rules

#### Scenario: User declines optional references

- **WHEN** an interactive user declines or selects no catalog datasets
- **THEN** setup leaves the public store available for manual additions and continues successfully
