# data-profile-observation Specification

## Purpose

A running data profile is observable. The data-profile workflow emits typed activity parts to its own durable event stream across its whole lifecycle — container provisioning, the agent loop and every tool call it makes, the vector-indexing pass, and a single terminal outcome — and its `cortex_analysis_state` row names the workflow producing them. Together those let a consumer subscribe to a profile's activity through the existing run-event read seam without deriving a workflow id or reading durability-engine tables.

## Requirements

### Requirement: The data-profile workflow emits its activity to a durable event stream

The data-profile workflow body SHALL write typed run-event parts to its own durable
`"events"` stream, so a consumer can observe what a live profile is doing. The body
SHALL NOT discard its agent loop's event sink.

The body SHALL emit `data-step-activity` parts carrying its synthetic frame
(`runId` `"data-profile"`, `stepId` `"profile"`) and a stable reconciling id, so
that a subscriber attaching part-way through a profile folds to the profile's
current activity rather than replaying every superseded intermediate.

A stream write that fails SHALL be swallowed and logged, never propagated. A
dropped observation frame is cosmetic and MUST NOT fail the profile — the same
stance the sandbox-step producer takes.

Every emission SHALL be awaited in body order. `DBOS.writeStream` allocates a
function id, so a fire-and-forget write would race the next operation for the
counter and desynchronise the recorded sequence on replay.

#### Scenario: A tool call the profiler makes becomes an activity part

- **WHEN** the profiler agent starts a tool call during a profile
- **THEN** the body emits a `data-step-activity` part whose `phase` is `executing`
  and whose `activity` is the human phrase derived from that tool's name and input
  (e.g. `Running script profile.py` for an `execute_command` invoking a script)

#### Scenario: A subscriber attaching mid-profile sees current activity, not history

- **WHEN** a consumer subscribes to a profile's stream after several tool calls have
  already been reported
- **THEN** the reconciling fold collapses those reports latest-wins onto the single
  activity id
- **AND** the consumer's first delivery describes what the profile is doing now

#### Scenario: A failed stream write does not fail the profile

- **WHEN** a `DBOS.writeStream` call rejects during a profile
- **THEN** the failure is logged and the profile continues to completion unaffected

### Requirement: The profile reports activity across its whole duration, not only its agent loop

The body SHALL emit, in this order:

| Where | Phase | Activity phrase |
|-|-|-|
| before creating its sandbox | `sandbox-init` | `Starting sandbox` |
| before starting the agent loop | `executing` | `Running data-profiler` |
| per tool call | `executing` | the phrase derived from the tool's name and input |
| the vector-store indexing pass | `indexing` | `Indexing input descriptions for search` |
| after the terminal ledger write | `complete` | `Profile complete` |
| on any terminal failure | `failed` | the user-safe ledger reason |

The phrases are normative. They are what a user reads, so leaving them to the
implementation would leave the observable result of this capability unspecified. They
follow the imperative-gerund vocabulary the sandbox-step producer established, so the
two producers read as one voice.

Emitting `sandbox-init` before sandbox creation is likewise normative rather than
incidental: container provisioning is the longest single operation in a profile and
precedes the agent loop entirely, so a body that emitted only from the loop would
leave the longest wait unreported. The `Running data-profiler` emission covers the
remaining gap between a ready sandbox and the agent's first tool call.

The body SHALL emit **exactly one** terminal activity. `complete` SHALL be emitted
only AFTER the terminal ledger write has succeeded: emitted before it, a ledger write
that then failed would reach the failure path and emit `failed` as well, leaving two
terminal activities for one profile and a fold whose winner depends on arrival order.
The sandbox teardown SHALL emit nothing, for the same reason.

The terminal `failed` activity SHALL carry the same user-safe reason persisted to
the ledger, never internal detail.

The body SHALL NOT emit the contract's remaining phases, and their absence is a
decision rather than an omission: `generating-metadata` and `generating-summary`
describe a post-agent pipeline a profile does not run, `persisting` describes an
artifact-store upload a profile does not perform, `retrying` requires a retry loop the
body does not have, and `warning` requires a non-fatal user-facing warning channel —
the body's two soft conditions are logged and neither warrants interrupting the
activity line.

#### Scenario: The wait for a container is reported

- **WHEN** the body begins creating the profile's sandbox
- **THEN** it has already emitted a `data-step-activity` part with `phase`
  `sandbox-init`
- **AND** a consumer subscribed at that moment can describe the profile as starting
  up rather than showing nothing

#### Scenario: The vector-indexing pass is reported

- **WHEN** the body indexes per-file descriptions into the analysis vector store
  after the agent has submitted its profile
- **THEN** it emits a `data-step-activity` part with `phase` `indexing`

#### Scenario: A profile that fails before its sandbox exists still reports a terminal phase

- **WHEN** a profile fails between emitting `sandbox-init` and starting the agent loop
- **THEN** it emits a terminal `failed` activity with no intervening `executing`
- **AND** a consumer keying on the terminal phase observes the profile as settled

#### Scenario: A completed profile reports a terminal phase

- **WHEN** a profile completes successfully
- **THEN** it emits exactly one `data-step-activity` part with `phase` `complete`

#### Scenario: A ledger write that fails does not produce two terminal activities

- **GIVEN** a profile whose agent submitted successfully
- **WHEN** its terminal ledger write fails and the body reaches its failure path
- **THEN** only a `failed` activity is emitted, and no `complete` activity precedes it

### Requirement: The emitted frame is a constant, not an identifier

The `runId` on a profile's emitted parts SHALL be the literal `"data-profile"` —
the same value for every analysis and every attempt — because that is the synthetic
frame the workflow already uses for its sandbox identity and its scratch path.

A consumer MUST NOT filter, key, or group a profile's activity by that `runId`. The
subscription is already scoped to one workflow, so the field carries no
disambiguating information. This is stated normatively because it is the one point
where a habit carried over from the analysis-run path — where `runId` genuinely
identifies a run — yields a wrong answer.

The activity part's reconciling `id` is likewise constant across analyses. This is
sound only because the fold's scope is a single stream and each profile attempt owns
its own stream; nothing SHALL fold two attempts' streams together.

#### Scenario: Two analyses profiling concurrently do not collide

- **WHEN** two different analyses each have a profile running
- **THEN** each profile writes to the stream of its own workflow
- **AND** each consumer subscribed to one workflow sees only that profile's activity,
  despite both carrying the identical `runId` and activity `id`

### Requirement: The ledger row names the workflow producing a profile's stream

`cortex_analysis_state` SHALL record the DBOS workflow id of the profile attempt
that owns the row, and the data-profile status read SHALL expose it. A consumer
SHALL be able to resolve which stream carries an analysis's profile activity from
the ledger row alone, without querying durability-engine tables and without
reconstructing an id from the workflow-id string format.

The workflow body SHALL write its own id as a durable step. The trigger MUST NOT
write it: the ledger claim happens before the workflow id is minted, so only the
body can report the id of the attempt that actually started.

The write SHALL be conditional on the row still being `running`, so a write that
lands late cannot stamp a workflow id onto a row that has already settled — which
would otherwise point a consumer at a workflow for a profile that is finished.

Beyond that guard the recorded id is **best-effort**, and this is a deliberate limit
rather than a gap to be closed. The stale-expiry claim admits two attempts each
believing itself the running one, and the earlier body's first step can then overwrite
the later attempt's id. The worst outcome is a consumer subscribing to a workflow whose
stream has already drained, so it observes no activity — which is the same state as a
profile that has reported nothing yet, and is rendered correctly. A missing activity
line for one profile is an acceptable cost; a wrong one would not be.

The recorded id SHALL be nullable. A row claimed but whose body has not yet written
its id, and a row written before this capability existed, both read back as absent —
which a consumer treats identically to a profile that is running but has reported no
activity yet.

#### Scenario: A consumer resolves a live profile's stream from the ledger

- **WHEN** a consumer reads the data-profile status for an analysis whose profile is
  running and whose body has recorded its id
- **THEN** the status carries the workflow id
- **AND** subscribing to the run-event read seam with that id delivers the profile's
  activity parts

#### Scenario: A re-profile is addressable at its new workflow

- **WHEN** a completed profile is re-triggered and a new attempt claims the row
- **THEN** the recorded workflow id is that of the new attempt, not the superseded one
- **AND** a consumer re-reading the status subscribes to the new attempt's stream

#### Scenario: A late write does not stamp a settled row

- **GIVEN** a profile row that has reached `completed` or `failed`
- **WHEN** a workflow-id write for that analysis lands afterwards
- **THEN** the row's recorded id is unchanged, so no consumer is pointed at a workflow
  for a finished profile

#### Scenario: A row with no recorded id is a normal state

- **WHEN** a consumer reads a `running` row whose body has not yet written its
  workflow id
- **THEN** the status reports no workflow id
- **AND** the consumer treats it as a running profile with nothing yet to observe,
  not as an error

### Requirement: A profile is observed through the existing run-event read seam

A profile SHALL be observable through the same run-scoped subscription the analysis
run path uses, with no widening of that seam. The seam SHALL NOT gain a
profile-specific mode, method, or option.

A profile is a workflow with no child step workflows — it records no step-execution
rows — so the seam's child discovery finds none and the parent stream draining is
the profile reaching a terminal state. That is the seam's existing behaviour applied
to a workflow without children, not a new case.

#### Scenario: Subscribing to a profile delivers its parts and then resolves

- **WHEN** a consumer subscribes to a profile's workflow id through the run-event
  read seam
- **THEN** every part the profile wrote is delivered, oldest-first, with reconciling
  parts folded
- **AND** the subscription resolves once the profile is terminal and its stream has
  drained

#### Scenario: Child discovery finds nothing and is harmless

- **WHEN** the seam's child discovery runs against a profile's workflow id
- **THEN** it finds no child workflows
- **AND** delivery of the profile's own parts is unaffected
