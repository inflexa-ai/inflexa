## MODIFIED Requirements

### Requirement: RunAuthorizer is the sole constructor of RunSession

`RunAuthorizer.authorize(input)` SHALL be the only seam that produces a
`RunSession`. It takes a single `AuthorizeRunInput` (`{ auth, scope, provenance, frame }`).
It is a gate, as the host-hooks spec defines it, and it returns
`ResultAsync<RunAuthorization, GateFailure>`. `RunAuthorization` is `{ runSession, ownsMandate }`.
`ownsMandate` is true only when this authorizer minted the run credential, thus the terminal
path must `revoke` it.

The local realization (`createLocalRunAuthorizer`) issues a durable session with
no remote mint, no revoke (`ownsMandate: false`). Embedders may provide their
own realization, but workflow bodies SHALL NOT re-authorize; the `RunSession`
rides in workflow input and DBOS replay reconstructs it from input.

#### Scenario: Local authorizer issues a RunSession it does not own

- **WHEN** `createLocalRunAuthorizer().authorize(input)` is called
- **THEN** it gives `ok({ runSession, ownsMandate: false })`, with `runSession` carrying the requested `RunFrame`

#### Scenario: A refused authorization is a value

- **GIVEN** a realization that refuses the authorization
- **WHEN** a caller runs `authorize(input)`
- **THEN** the result is an `err` that carries a `GateFailure`
- **AND** the realization throws nothing

#### Scenario: Workflow bodies do not mint

- **WHEN** `executeAnalysis` or `sandboxStep` executes
- **THEN** no run authorization call is made inside the workflow body
