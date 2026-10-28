# Spec Delta

## MODIFIED Requirements

### Requirement: The agent maintains working memory through one section-addressable tool

The harness SHALL expose a single `update_working_memory` tool as the agent's interface for maintaining working memory, and SHALL expose no read tool for it (the rendered document is already injected every turn). It SHALL be section-addressable: `goal` is set whole; `constraint`, `hypothesis`, and `finding` each take `add`/`revise`/`retire` operations addressing an entry by its id. `add` on a `finding` SHALL require a `runId`; `revise`/`retire` SHALL NOT, addressing the finding by its own id instead. A `runId` that names no run of this analysis SHALL be refused with a model-correctable error — never stored as a dangling reference.

The `update_working_memory` description MUST state the promotion criteria. A binding rule that the user states goes to `constraints`, a durable conclusion goes to `findings`, and the `goal` stays current. The conversation prompt MUST NOT restate the criteria, because the model reads the description at the call.

#### Scenario: Adding a finding requires a runId

- **WHEN** an `update_working_memory` call adds `section: "finding"` with no `runId`
- **THEN** input validation fails and the loop produces an `is_error` tool result

#### Scenario: Retiring a finding does not

- **WHEN** an `update_working_memory` call sets `section: "finding", operation: "retire", id: "<entry id>"` and no `runId`
- **THEN** the call is accepted and the finding is removed

#### Scenario: Revising an entry requires its id

- **WHEN** an `update_working_memory` call sets `operation: "revise"` with no `id`
- **THEN** input validation fails and the loop produces an `is_error` tool result

#### Scenario: An unknown runId is refused

- **WHEN** a finding is added citing a `runId` that belongs to no run of this analysis
- **THEN** the tool returns a model-visible error naming the remedy, and nothing is stored
