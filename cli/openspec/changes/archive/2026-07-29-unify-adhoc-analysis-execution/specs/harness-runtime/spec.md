## MODIFIED Requirements

### Requirement: On-demand composition of the embedded harness runtime

The system SHALL provide a composition module that boots the embedded harness
runtime on first use and reuses it for the remainder of the process. Boot SHALL
sequence: ensure Postgres readiness; in callback mode only, start the callback
listener; register the durable workflows with fully realized deps — sandbox-step
before execute-analysis, plus data-profile, target-assessment, and
sandbox-hygiene scheduled workflows; run pre-launch migration/hooks; then launch
DBOS. No ephemeral execution workflow SHALL be registered. Poll transport
remains the default. Passive flows SHALL NOT boot the runtime. A second boot
request SHALL return the singleton without re-registration or re-launch.

#### Scenario: First trigger boots the runtime in poll mode

- **WHEN** a profile or analysis launch first requests the runtime
- **THEN** Postgres is ready, the non-ephemeral workflow cohort is registered, legacy pre-launch migration/hooks run, and DBOS launches in that order
- **AND** no callback listener is bound

#### Scenario: Callback mode additionally binds the listener

- **WHEN** runtime boots in callback transport mode
- **THEN** the exec-callback listener starts after Postgres readiness and before registration

#### Scenario: Subsequent triggers reuse the runtime

- **WHEN** a second launch is requested in the same process
- **THEN** no re-registration or re-launch occurs

#### Scenario: Unavailable Postgres blocks boot with actionable guidance

- **WHEN** runtime boot cannot reach ready Postgres
- **THEN** boot fails actionably and DBOS is not launched

#### Scenario: One registration cohort

- **WHEN** recovery resumes any supported in-flight workflow
- **THEN** its registered name exists in the one pre-launch cohort

### Requirement: Local realizations for every conversation dependency

The composition SHALL realize the conversation agent's dependency surface from
deliberate local wiring, reusing shared pool, embedding, workspace filesystem,
session-tree, bio-key, authorizer, and launcher realizations. It SHALL supply:

- the conversation provider/model resolved under the `conversation` role for the
  chat agent and its conversation sub-agents;
- the utility provider/model resolved under the `utility` role for the
  harness-owned ad hoc router;
- config-overridable skills/templates paths with the existing release/development
  defaults and pre-flight gates;
- empty local Chrome config and the unavailable preview publisher;
- the `run_inflexa` host tool through the host-tool seam.

The utility role SHALL use the same configured connection and credential
realization as the other roles. The CLI SHALL NOT supply routing prompts,
candidate agent ids, or selection decisions.

#### Scenario: Conversation and utility deps resolve to their roles

- **WHEN** the runtime composes a conversation model distinct from utility
- **THEN** chat/sub-agent traffic uses conversation and ad hoc routing uses utility over the same configured connection

#### Scenario: Report preview degrades visibly, report building does not

- **WHEN** the agent attempts local report preview
- **THEN** preview reports unavailability and report iteration/submission still works

#### Scenario: The conversation agent carries the inflexa CLI host tool

- **WHEN** runtime composes the conversation agent
- **THEN** `run_inflexa` is present through `hostTools`

## ADDED Requirements

### Requirement: Ephemeral configuration and workflow wiring are absent

The resolved CLI `ResourcePolicy` SHALL contain only per-step ceilings and the
machine budget. The CLI SHALL NOT project `harness.resourceLimits.ephemeral`,
build ephemeral workflow dependencies, or supply an ephemeral callable to the
harness composition. A stale on-disk ephemeral setting MAY be tolerated during
the upgrade window but SHALL have no runtime effect.

#### Scenario: Runtime composes ordinary resource policy

- **WHEN** the CLI resolves its harness configuration
- **THEN** the supplied policy has `perStep` and `budget` and no `ephemeral` field

#### Scenario: Workflow cohort has no ephemeral dependency

- **WHEN** the CLI constructs `CoreWorkflowDeps`
- **THEN** it supplies no ephemeral dependency bundle and registers no ephemeral workflow

### Requirement: Legacy ephemeral sweep remains a pre-launch migration

During the supported upgrade window, the CLI SHALL call the harness's
executor-scoped legacy ephemeral sweep after workflow registration and before
DBOS launch. The call exists only to cancel pending rows left by an older binary
and SHALL NOT imply an ephemeral tool, agent, resource policy, dependency
bundle, or workflow registration.

#### Scenario: Old pending row exists during upgrade

- **GIVEN** the local executor owns a pending legacy `ephemeral:*` DBOS row
- **WHEN** the new CLI reaches its pre-launch hook
- **THEN** it cancels the row before recovery and then launches without an ephemeral workflow registration
