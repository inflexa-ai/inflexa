## MODIFIED Requirements

### Requirement: Tools declare an execution mode

Every tool MUST declare or default to an execution mode: `step`, `workflow`,
or `inline`. A `step` tool MUST run through a deterministic durable step
wrapper. A `workflow` tool MUST run through a workflow-backed execution path.
A tool declares the `workflow` mode when it uses a body-only DBOS operation or
more than one durable operation. The mode also applies to a tool that mutates
durable workspace state inside a workflow. An `inline` tool is reserved for
pure deterministic logic with no external side effects.

`execute_command` declares `executionMode: "workflow"` because it submits a
command and then receives the result with `DBOS.recv`, which is illegal in
step context. `write_file` and `edit_file` declare the same mode for a
different reason: each mutates durable workspace state inside a workflow. The
two file tools hold no `DBOS.recv`.

#### Scenario: Default external tool is step-backed

- **WHEN** an external lookup tool is constructed without a special mode
- **THEN** it runs as a `step` tool through the deterministic durable wrapper

#### Scenario: Mutate-surface tool is workflow-backed

- **WHEN** `execute_command`, `write_file`, or `edit_file` is constructed
- **THEN** it declares `executionMode: "workflow"`

#### Scenario: Inline mode is pure only

- **WHEN** a tool declares `executionMode: "inline"`
- **THEN** review and tests make sure that it has no external side effects and no DBOS durability
