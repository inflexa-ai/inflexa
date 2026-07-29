## MODIFIED Requirements

### Requirement: Chat runs in-process; durable operations run as DBOS workflows

Chat turns SHALL run in-process, single-replica per turn, with no workflow or
step rows. User-named long operations (`executeAnalysis`,
`executeTargetAssessment`, and the data-profile task) SHALL run as DBOS
workflows started from tools and SHALL be independent of the chat turn that
triggered them. Planned and ad hoc analysis modes SHALL both launch
`executeAnalysis`; there SHALL be no separate turn-scoped computation workflow.
The same `runAgent` body SHALL serve both modes through an injected `RunStep` —
`passthroughStep` in chat, `durableStep` inside workflow steps.

#### Scenario: A tool starts a workflow that outlives the chat turn

- **GIVEN** a chat turn whose agent dispatches `execute_analysis`
- **WHEN** the tool launches the `executeAnalysis` workflow
- **THEN** the workflow runs independently of the in-process chat turn and continues if the turn ends

#### Scenario: A pod death mid-turn does not lose durable work

- **GIVEN** a chat turn that has already started a durable workflow
- **WHEN** the host process dies mid-turn
- **THEN** the user re-sends the message and the already-running workflow is unaffected

## ADDED Requirements

### Requirement: Legacy ephemeral rows are cancelled before recovery

The runtime SHALL retain an executor-scoped pre-launch migration
sweep that marks pending legacy ephemeral workflows cancelled before DBOS
recovery while upgrades from binaries that created `ephemeral:*` rows remain
supported. No registered tool or workflow in the new runtime SHALL create an
`ephemeral:*` row.

#### Scenario: Upgrade encounters a pending legacy row

- **GIVEN** a pending `ephemeral:*` workflow owned by the runtime's stable executor id
- **WHEN** the new runtime performs its pre-launch migration hooks
- **THEN** it cancels that row before DBOS recovery starts
- **AND** no ephemeral workflow registration is required to execute it

## REMOVED Requirements

### Requirement: runEphemeral is a turn-scoped workflow

**Reason**: Turn-scoped execution blocked chat, timed out frequently, and could
not persist ordinary analysis artifacts.

**Migration**: Call `execute_analysis` in `adhoc` mode. Existing pending
`ephemeral:*` rows are settled by the temporary pre-launch legacy sweep.
