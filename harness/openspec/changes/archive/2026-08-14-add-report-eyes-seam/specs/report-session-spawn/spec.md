## ADDED Requirements

### Requirement: The spawn refuses a composition with no eyes
The spawn MUST refuse when the composition gives no eyes. No eyes means: no capture seam, no eyes seam, and no configured browser endpoint. The refusal is typed data with the reason `no_browser`, and no thread is written. A report session records a version only after a look at the rendered page. Thus a session under a composition with no eyes is a dead end, and the refusal at the spawn is the honest answer.

An eyes seam alone MUST satisfy the gate. A capture seam alone MUST satisfy the gate. A configured browser endpoint alone MUST satisfy the gate.

#### Scenario: A composition with no eyes refuses

- **WHEN** the caller spawns under a composition with no capture seam, no eyes seam, and no browser endpoint
- **THEN** the spawn refuses with `no_browser`, and no thread is written

#### Scenario: An eyes seam satisfies the gate

- **WHEN** the composition binds an eyes seam and no browser endpoint
- **THEN** the spawn does not refuse for the eyes
