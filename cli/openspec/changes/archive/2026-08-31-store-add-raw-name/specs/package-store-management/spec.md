# package-store-management Delta

## ADDED Requirements

### Requirement: A request carries its raw spelling beside its identity

A `store add` request MUST keep the spelling that the user gave, beside
the canonical identity. The canonical form keys the flight, the dedupe,
and the pool. The raw spelling MUST reach the installer, because an R name
is case-sensitive and can carry dots. The raw spelling MUST also reach
every render: the sidebar pipeline, `store ls`, the refusal messages, and
the both-hit ask. Without `--lang`, each ecosystem MUST be probed in its
own spelling, thus the both-hit guard stays armed for a name that both
ecosystems hold.

#### Scenario: A dotted R name reaches pak unchanged

- **WHEN** `inflexa store add GO.db --lang r` flushes
- **THEN** the provisioner spec carries `GO.db`, not `go-db`

#### Scenario: Two spellings make one flight

- **GIVEN** a pending `GO.db` and a pending `go.db`, both for R
- **WHEN** the flush claims the set
- **THEN** one flight runs, and its render shows the first raw spelling

#### Scenario: The render shows the name the user typed

- **GIVEN** a failed flight for `GO.db`
- **WHEN** the sidebar or `store ls` renders the row
- **THEN** the row reads `GO.db`, never `go-db`

#### Scenario: The both-hit guard arms for a dotted name

- **GIVEN** a name that PyPI holds under the mangled form and CRAN holds under the raw form
- **WHEN** the add runs without `--lang`
- **THEN** the run stops with the two candidates, and nothing installs silently
