## RENAMED Requirements

- FROM: `### Requirement: The provenance seam delivers each event with the run session from durable workflow input`
- TO: `### Requirement: The run emit delivers each event with the session of its emit site`

## MODIFIED Requirements

### Requirement: The run emit delivers each event with the session of its emit site

The run emit of the `ProvenanceSeam` MUST take `(event: RunProvenanceEvent, session: AgentSession)`.
Each emit site in a workflow body MUST pass the `RunSession` from the durable input of the workflow.
That site never passes a session reconstructed out of band, re-minted, or correlated from the calls of
another member or hook. The run canceler is the one emit site outside a workflow body. It MUST pass the session
that its caller gave to the cancel.

A realization that persists an observation to an external store makes an authenticated wire call.
The session carries the authority, the scope, and the acting identity that the call needs. For an event
of the canceler, these are the authority and the identity of the actor that canceled the run.

The parameter MUST be the `AgentSession`, because a `RunSession` is one and the session of a cancel
is one. The canceler cannot hold a `RunSession`: `RunAuthorizer.authorize` is the sole constructor of
a `RunSession`, and a cancel authorizes no run.

An implementation can ignore the parameter. The delivery of the session MUST NOT change the
fire-and-forget behavior of the run emit, its guarded call, or the timestamps that the events carry.

#### Scenario: Every emit site passes the durable input's session

- **WHEN** `executeAnalysis` fires `run_started`, `step_completed`, and `run_completed` with an observer supplied
- **THEN** each invocation receives the exact `RunSession` object from the workflow's durable input alongside the event

#### Scenario: The canceler passes the session of the cancel

- **WHEN** the run canceler fires `step_completed` and `run_completed` for a run that it canceled
- **THEN** each invocation receives the exact session object that the caller gave to `cancel`

#### Scenario: An implementation that ignores the session stays correct

- **WHEN** a host supplies an observer that declares only the event parameter
- **THEN** it typechecks and receives every event exactly as before

#### Scenario: A recovery re-fire carries the same session

- **WHEN** the workflow body re-executes after a DBOS recovery
- **THEN** each re-fired emission carries the session reconstructed from the same serialized workflow input, so the observation attributes to the same authority, scope, and identity
