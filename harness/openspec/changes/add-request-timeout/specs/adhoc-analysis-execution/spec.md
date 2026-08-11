# adhoc-analysis-execution Delta

## MODIFIED Requirements

### Requirement: Utility router selects a specialist and resources

Before the harness constructs a new ad hoc plan, it MUST make one structured
call through its required utility provider/model. The deadline of the call MUST
be the maximum of the 10-second default and the advertised `requestTimeoutMs`
of the utility provider. An explicit `timeoutMs` dep, when set, overrides the
derived deadline. The call MUST receive the request, the data-profile
orientation that the server loads, the plannable specialist catalog, and the
explicit resource bounds (lower, default, upper). It MUST have no workspace
tools and no execution tools.

Its result can recommend a specialist id, and it can recommend a resource
specification. But the result MUST NOT change the requested execution mode,
make a DAG, or reject the request as plan-only.

The harness MUST accept only an id in the plannable catalog as a routed
specialist. `scientific-executor` MUST NOT be a candidate. It MUST serve only
as the deterministic agent fallback when the selection is absent, invalid,
timed out, or failed.

The router MUST validate the resource output independently. Absent, malformed,
or out-of-bounds resources MUST use the ordinary default. A resource failure
MUST NOT discard a valid agent selection. An agent failure MUST NOT discard
valid resources.

#### Scenario: Targeted request selects a specialist

- **GIVEN** the request and data profile clearly match a plannable specialist
- **WHEN** the utility call returns that specialist and valid resources
- **THEN** the internal step stores and uses both recommendations

#### Scenario: Router cannot select an agent

- **WHEN** the utility call times out, errors, returns no match, or returns an id outside the plannable catalog
- **THEN** the step uses `scientific-executor`
- **AND** the failure class or fallback rationale is recorded

#### Scenario: A slow provider raises the router deadline

- **GIVEN** a utility provider that advertises a `requestTimeoutMs` above 10 seconds
- **WHEN** the router makes its structured call
- **THEN** the deadline is the advertised value, not the 10-second default

#### Scenario: Invalid resources do not erase a valid route

- **GIVEN** the router returns a valid specialist and resources above the stated ceiling
- **WHEN** the result is validated
- **THEN** the specialist is retained and resources use the bounded default

#### Scenario: Router does not overrule ad hoc mode

- **GIVEN** the conversation agent called ad hoc mode with an explicit user request
- **WHEN** the utility model considers the request broad
- **THEN** it still returns or falls back to a one-step route and cannot force plan generation
