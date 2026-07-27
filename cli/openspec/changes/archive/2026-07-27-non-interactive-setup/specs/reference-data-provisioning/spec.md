# reference-data-provisioning Specification (delta)

## MODIFIED Requirements

### Requirement: Setup reuses the reference download handler

Interactive `inflexa setup` SHALL deliberately create the reference-store and `user/` directories, inspect catalog installation state, and offer missing or updateable datasets with their sizes through the same headless download operation used by `inflexa refs download`. The offer SHALL be the per-dataset picker over the datasets setup is actually offering — the missing or updateable ones — so an intact dataset is never re-offered and the select-everything key never means "everything already installed". The recommended key SHALL select the recommended datasets within that offered set.

Before the picker, setup SHALL state how many datasets are already installed and intact and therefore absent from the listing.

Setup SHALL also state how references can be obtained later: by running `inflexa refs download` for a dataset, or by asking the agent in chat, which proposes that same command for the user's approval. That statement SHALL remain true of the shipped command surface, and SHALL be presented where it can inform the choice rather than only after an empty one. Where the terminal is wide enough to carry it without squeezing the listing below a usable width, it SHALL be presented alongside the listing so it remains visible as the listing scrolls; otherwise it SHALL be presented above the listing. It SHALL carry the same wording in either presentation, and SHALL NOT be repeated once a selection is made.

Declining or selecting nothing SHALL continue setup. A selected installation failure SHALL fail setup visibly.

The reference selection SHALL be answerable as `--refs recommended|all|<id,…>` (file: `refs`). `recommended` SHALL resolve to the catalog-recommended datasets within the offered set; `all` to the whole offered set; both preset words SHALL be validated against catalog ids so a colliding dataset id is a loud catalog-authoring error, never a shadowed selection. An explicit selection IS the consent — no separate consent flag is required, interactively or headless; the resolved plan is subject to the same verification, activation, and receipt path as `inflexa refs download`. Under batch resolution (`--yes` or non-TTY) with no refs answer, setup SHALL download no reference bytes: it SHALL print the reference-store path and an actionable `inflexa refs download` command and continue.

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

#### Scenario: Batch setup without a refs answer downloads nothing

- **WHEN** setup runs under batch resolution (`--yes` or no TTY) without a refs answer
- **THEN** it downloads nothing — even with `--yes` given — prints how to install references later, and continues

#### Scenario: A refs preset resolves against the offered set

- **WHEN** `setup --yes --refs recommended` runs while one recommended dataset is already installed and intact
- **THEN** the plan contains the missing recommended datasets only, and the installed one is not re-fetched

#### Scenario: An explicit selection needs no separate consent

- **WHEN** setup runs with `--refs CollecTRI` (with or without a TTY)
- **THEN** no picker is offered and the named dataset downloads without any further consent flag — the answer is the consent

#### Scenario: User declines optional references

- **WHEN** an interactive user declines or selects no catalog datasets
- **THEN** setup leaves the public store available for manual additions and continues successfully
