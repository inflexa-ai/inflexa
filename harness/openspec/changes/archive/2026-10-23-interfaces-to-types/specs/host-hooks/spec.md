## MODIFIED Requirements

### Requirement: A host hook is a gate or a notice

Each host hook MUST be a gate or a notice, and the type of the hook MUST show its kind. A gate gives a value or a
permission that is necessary before the harness can continue an operation. A notice reports a fact after the
operation.

```ts
type GateFailure = { readonly reason: string; readonly suspend: boolean }
type NoticeFailure = { readonly reason: string }

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
