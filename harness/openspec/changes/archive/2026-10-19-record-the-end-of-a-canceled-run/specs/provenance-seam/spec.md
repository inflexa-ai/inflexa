## MODIFIED Requirements

### Requirement: One seam carries the provenance surface

The harness MUST declare one `ProvenanceSeam` type with three optional
members: the run emit, the session emit, and the document read. Each member
is optional alone, and the harness treats an absent member as absence, never
as an error. The code of the harness never branches on which realization is
bound. A session act carries no session, thus the session emit takes the
event alone.

The run emit takes an `AgentSession` parameter, because each of its emit sites
holds one. The workflow body passes the `RunSession` of its durable input. The
run canceler passes the session of the cancel.

#### Scenario: A partial binding works

- **WHEN** the composition binds only the session emit
- **THEN** the session acts emit, the run events go nowhere, and the page
  carries no document asset

#### Scenario: The run emit receives the session

- **WHEN** the workflow emits a run event through the bound member
- **THEN** the member receives the event and the `RunSession` of the run

#### Scenario: The run emit receives the session of the cancel

- **WHEN** the run canceler emits the end of a run that it canceled
- **THEN** the member receives the event and the session that the caller gave to the cancel
