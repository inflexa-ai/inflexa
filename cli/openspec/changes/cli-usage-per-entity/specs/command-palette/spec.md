## ADDED Requirements

### Requirement: The Switch analysis picker carries each analysis's recorded total

The Switch analysis picker's rows SHALL each carry that analysis's total recorded token figures, in the shared notation, alongside the identity the row already shows.

This is the one aggregate the interface keeps. Every other surface reports the entity it names or the open working context; the picker is where analyses are compared, which is the only question a whole-analysis total answers. Placing it here is also what lets the chat rail hold no summed figure at all, so a rail section can never be read as a total whose parts fail to add up.

The totals SHALL be read in ONE query over the listed analyses rather than one query per row, and SHALL come from the CLI's own local ledger, so the picker opens with the harness runtime stopped exactly as it does today.

An analysis with no recorded usage SHALL render its row without a figure rather than with a zero, and a failed usage read SHALL leave every row rendered and selectable without figures — a picker that cannot switch analyses because a bookkeeping read failed is a worse outcome than a picker with no figures.

#### Scenario: Analyses are comparable by what they cost

- **GIVEN** several analyses of differing recorded consumption
- **WHEN** the Switch analysis picker opens
- **THEN** each row carries its own analysis's totals

#### Scenario: The picker opens with the runtime stopped

- **GIVEN** recorded usage and no running harness runtime
- **WHEN** the picker opens
- **THEN** the rows render with their figures

#### Scenario: An analysis with no usage shows no figure

- **GIVEN** an analysis with no ledger rows
- **WHEN** the picker renders it
- **THEN** its row carries no figure rather than a zero

#### Scenario: A failed usage read still lets the user switch

- **GIVEN** a usage read that fails
- **WHEN** the picker opens
- **THEN** every analysis is listed and selectable, without figures
