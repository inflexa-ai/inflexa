# farm-composition Delta

## ADDED Requirements

### Requirement: The canonical name is a lookup identity only

The canonical distribution name (the PEP 503 form) MUST serve as the
lookup identity: the flight keys, the pool inventory, the graph names, and
the request resolution. It MUST NOT serve as an installer ref, and it MUST
NOT replace a raw spelling on a user surface. A Python installer accepts
the canonical form, because PEP 503 defines the equivalence. An R
installer does not, thus the boundary is a requirement and not a style.

#### Scenario: A lookup matches every spelling

- **GIVEN** a pool that holds the identity of `GO.db`
- **WHEN** a farm request names `go.db`
- **THEN** the lookup resolves the same pool directory

#### Scenario: The canonical form never reaches an installer

- **GIVEN** a request whose raw spelling is `GO.db`
- **WHEN** the acquisition builds the installer ref
- **THEN** the ref carries `GO.db`, and the canonical form stays in the keys

#### Scenario: The seam echoes the requested spelling

- **GIVEN** a `link_packages` request for `GO.db` that the pool does not hold
- **WHEN** the seam reports the outcome
- **THEN** the outcome names `GO.db`, thus a remedy built from it stays installable
