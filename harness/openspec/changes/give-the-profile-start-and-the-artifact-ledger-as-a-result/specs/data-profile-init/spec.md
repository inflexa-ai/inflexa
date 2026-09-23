## ADDED Requirements

### Requirement: The profile trigger and the profile run give their outcome as a Result

`runDataProfile` MUST return `ResultAsync<void, DataProfileStartError>`. `DataProfileStartError` MUST have two
variants:

- `refused`, with the `reason` and the `suspend` flag of the host.
- `start_failed`, with the `cause` of the failed start.

If `authorize` gives an `err`, `runDataProfile` MUST set the claimed row to `failed`, as the gate requirement
describes. Then it MUST give the `refused` variant. If the start of the workflow fails, `runDataProfile` MUST set the
claimed row to `failed` with a bounded reason. Then it MUST give the `start_failed` variant. It MUST NOT reject for
either variant.

If the promise of `authorize` rejects, that is a defect of the host. `runDataProfile` MUST set the claimed row to
`failed`, and the rejection MUST pass through with no change.

`triggerDataProfile` MUST return `ResultAsync<DataProfileTriggerResult, DbError>`. Each outcome of
`DataProfileTriggerResult` MUST be an `ok` value, and that includes `"failed"`. A failed ledger read, a failed claim,
or a failed empty-set stamp MUST be the `err`. The trigger MUST NOT wait for the dispatch after a claim. The dispatch
settles its own row. Thus a refusal or a failed start after a claim shows on the ledger only.

#### Scenario: A refused run gives the refusal after it fails the row

- **GIVEN** a profile row that `tryRetryDataProfile` claimed, and a `RunAuthorizer` whose `authorize` gives an `err` with the reason `"no_funds"` and `suspend: false`
- **WHEN** the caller calls `runDataProfile`
- **THEN** it gives an `err` of the variant `refused` with the reason `"no_funds"` and `suspend: false`
- **AND** the profile row is `failed` with the reason `"no_funds"`

#### Scenario: A failed start gives the cause after it fails the row

- **GIVEN** a profile row that `tryRetryDataProfile` claimed, and a DBOS runtime that does not start the workflow
- **WHEN** the caller calls `runDataProfile`
- **THEN** it gives an `err` of the variant `start_failed`
- **AND** the profile row is `failed`

#### Scenario: A ledger fault of the trigger is an err

- **GIVEN** a ledger connection whose read fails
- **WHEN** the caller calls `triggerDataProfile`
- **THEN** it gives an `err` with the `DbError` of the read, and not the outcome `"failed"`

#### Scenario: A refusal after a claim of the trigger shows on the ledger

- **GIVEN** a seeded `pending` profile row, and a `RunAuthorizer` whose `authorize` gives an `err`
- **WHEN** the caller calls `triggerDataProfile`
- **THEN** it gives `ok("started")`
- **AND** the profile row then reaches `failed` with the reason of the host
