## MODIFIED Requirements

### Requirement: The kind of each hook

Each hook MUST have the kind that this table gives. A gate that succeeds MUST give the value in the `Value` column. If
the table gives no value, the `ok` of the hook MUST carry `void`.

| Hook | Kind | Value |
|-|-|-|
| `RunAuthorizer.authorize` | gate | `RunAuthorization` |
| `RunAuthorizer.revoke`, `RunAuthorizer.revokeByMandateId`, `RunAuthorizer.suspend` | notice | none |
| `RunAuthorizer.renew` | gate | none |
| `resolveRequestHeaders` | gate | `RequestHeaders` |
| `resolveSandboxLabels` | gate | `SandboxLabels` |
| `RunCharge.open` | gate | none |
| `RunCharge.close` | notice | none |
| `ArtifactRegistry.register` | gate | `ExternalRegistrationResult` |
| `ArtifactRegistry.sync` | notice | none |
| `UsageRecorder.record` | notice | none |

`RunCharge.open` gives no value, but a run MUST NOT start if `RunCharge.open` fails. Thus `RunCharge.open` is a gate.
`ArtifactRegistry.sync` gives no value, and `queryUnsyncedStepArtifacts` selects each row again after a failure. Thus
`ArtifactRegistry.sync` is a notice.

`UsageRecorder.record` stays off the path of the loop. The loop MUST NOT wait for the result of `record`. When the
result arrives, the loop MUST log an `err`.

#### Scenario: The type of a gate carries its value

- **WHEN** a host writes a realization of `RunAuthorizer.authorize`
- **THEN** the realization returns `ResultAsync<RunAuthorization, GateFailure>`

#### Scenario: The type of a notice carries no value

- **WHEN** a host writes a realization of `RunCharge.close`
- **THEN** the realization returns `ResultAsync<void, NoticeFailure>`

#### Scenario: A realization of the old contract does not compile

- **GIVEN** a realization of `UsageRecorder.record` that returns `void`
- **WHEN** the embedder compiles its composition root
- **THEN** the compilation fails
