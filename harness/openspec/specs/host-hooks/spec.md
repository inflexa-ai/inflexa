# host-hooks Specification

## Purpose

Define the hooks that a host gives to the harness. Each hook is a gate or a notice, and its type shows its
kind. A gate gives a value that an operation must have. A notice reports a fact after an operation. The harness
calls each hook through one helper for each kind, with no `try` and no `catch` around the call.

## Requirements

### Requirement: A host hook is a gate or a notice

Each host hook MUST be a gate or a notice, and the type of the hook MUST show its kind. A gate gives a value or a
permission that is necessary before the harness can continue an operation. A notice reports a fact after the
operation.

```ts
interface GateFailure { readonly reason: string; readonly suspend: boolean }
interface NoticeFailure { readonly reason: string }

// A gate.
(input) => ResultAsync<T, GateFailure>
// A notice.
(input) => ResultAsync<void, NoticeFailure>
```

If a gate gives an `err`, the operation MUST fail with the reason of the host. If `suspend` is also true, the
operation MUST suspend in place of the failure, as the `workflow-suspension` capability describes.

If a notice gives an `err`, the harness MUST log the reason at the error level. The outcome of the operation MUST NOT
change, because the work is complete.

The harness MUST call each hook through one of two internal helpers, one for each kind. Thus no call site selects its
own failure policy. A call site MUST NOT put a `try` or a `catch` around a hook.

A hook MUST give a failure as an `err`, not as a throw or a rejected promise. If the promise inside a hook rejects,
that is a defect of the host. The harness MUST NOT catch the rejection.

#### Scenario: A gate err fails the operation

- **GIVEN** a gate that gives `errAsync({ reason: "r", suspend: false })`
- **WHEN** the harness calls the gate through the gate helper
- **THEN** the operation fails, and the failure carries the reason `r`

#### Scenario: A gate err with suspend suspends the operation

- **GIVEN** a gate that gives `errAsync({ reason: "r", suspend: true })`
- **WHEN** the harness calls the gate through the gate helper
- **THEN** the operation suspends with the reason `r`, and it does not fail

#### Scenario: A notice err does not change the outcome

- **GIVEN** an operation that succeeded, and a notice that gives `errAsync({ reason: "r" })`
- **WHEN** the harness calls the notice through the notice helper
- **THEN** the harness logs the reason `r` at the error level
- **AND** the operation stays a success

#### Scenario: A rejected hook promise is a defect of the host

- **GIVEN** a hook whose promise rejects
- **WHEN** the harness calls the hook through its helper
- **THEN** the helper does not catch the rejection, and it does not change the rejection into an `err`

### Requirement: The kind of each hook

Each hook MUST have the kind that this table gives. A gate that succeeds MUST give the value in the `Value` column. If
the table gives no value, the `ok` of the hook MUST carry `void`.

| Hook | Kind | Value |
|-|-|-|
| `RunAuthorizer.authorize` | gate | `RunAuthorization` |
| `RunAuthorizer.revoke`, `RunAuthorizer.revokeByJti` | notice | none |
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

### Requirement: The model request headers hook

Each provider (`ai-sdk`, `anthropic`, and `embedding`) MUST take an optional gate
`resolveRequestHeaders: (session: ResolvableSession) => ResultAsync<RequestHeaders, GateFailure>`. `RequestHeaders` is
`Readonly<Record<string, string>>`. `ResolvableSession` MUST extend the session view `HookSessionView` with the opaque
`auth`.

The provider MUST call the hook before each attempt of a model request. The provider MUST add the headers to the
request as the hook gives them. If the hook is absent, the provider MUST add no headers. The harness MUST NOT make an
attribution header itself.

If the hook gives an `err`, the request MUST fail at once, with no retry, because the hook is not the model wire. The
provider MUST NOT send the attempt that the hook refused. The provider MUST give a `ProviderError` with
`retryable: false`. Its message MUST
name the workload and carry the reason of the host. If `suspend` is true, the error MUST have the kind `suspend`, with
the reason and with no status. If `suspend` is false, the error MUST have the kind `provider`.

#### Scenario: The headers reach the request as the hook gives them

- **GIVEN** a hook that gives `okAsync({ "x-attribution": "a1" })`
- **WHEN** the provider sends a model request
- **THEN** the request carries the header `x-attribution` with the value `a1`, with no change

#### Scenario: An absent hook adds no headers

- **GIVEN** a provider with no `resolveRequestHeaders`
- **WHEN** the provider sends a model request
- **THEN** the request carries no header from a hook

#### Scenario: The hook runs before each attempt

- **GIVEN** a wire that fails one time with a `503` and then succeeds
- **WHEN** the provider runs the model call
- **THEN** the provider calls the hook two times, one time before each attempt

#### Scenario: A hook err stops the request at once

- **GIVEN** a hook that gives `errAsync({ reason: "r", suspend: false })`
- **WHEN** the provider runs a model call
- **THEN** the provider sends no request, and it does not retry
- **AND** the call gives an `err` of the kind `provider` with `retryable: false`, and its message carries `r`

#### Scenario: A hook err with suspend gives a suspend error

- **GIVEN** a hook that gives `errAsync({ reason: "r", suspend: true })`
- **WHEN** the provider runs a model call
- **THEN** the call gives an `err` of the kind `suspend` with the reason `r` and with no status

#### Scenario: A hook err on a later attempt stops the retries

- **GIVEN** a wire that fails with a `503`, and a hook that gives `ok` first and `err` second
- **WHEN** the provider runs the model call
- **THEN** the provider makes one wire call, and the call gives the `err` of the hook with no further retry

### Requirement: The harness carries hook values and host reasons unread

The harness MUST NOT read the content of a request header or a sandbox label that a hook gives. It MUST NOT parse such
a value, do a check of it, or rewrite it.

The harness MUST carry the reason of a `GateFailure` or a `NoticeFailure` as an opaque string. It MUST NOT branch on
the reason or parse it. A branch on the flag `suspend` is permitted, because the flag is part of the contract.

#### Scenario: Two host reasons give the same outcome

- **GIVEN** two gate failures that differ only in `reason`
- **WHEN** the same operation gets each failure
- **THEN** the two outcomes differ only in the reason that they carry

#### Scenario: A header that no harness code names reaches the wire

- **GIVEN** a request headers hook that gives a key that no harness code names
- **WHEN** the provider sends the request
- **THEN** the request carries the key and its value exactly as the hook gave them
