# harness-sandbox-exec — delta

## ADDED Requirements

### Requirement: In poll mode sustained unavailability escalates to a liveness probe

The client-composed poll loop SHALL track consecutive `unavailable` poll
outcomes: an `ok` poll resets the count. When the count reaches the escalation
threshold (a module constant, like the poll cadence), the loop SHALL run one
liveness probe — the backend inspect (`SandboxClient.isAlive(ref)`) — as a
durable step named `sandbox.probe-liveness.${execId}.${k}` in the loop's
existing attempt sequence. The probe schedule SHALL be a pure function of the
checkpointed poll outcomes, so a replay issues the same polls and probes in the
same order. The loop SHALL NOT use `DBOS.recv`, a per-exec topic, or any
cross-workflow message for the verdict.

The probe verdict SHALL be three-valued and the probe step SHALL never throw:

- **dead** — the machine is observably dead and no completion has been
  received: the loop SHALL return the synthetic-failure `ExecResult` instead of
  waiting out the deadline, with reason `"sandbox-oom-killed"` when the backend
  attributes the death to the machine's memory limit and `"sandbox-dead"`
  otherwise. The synthetic result SHALL be built by the same constructor the
  watchdog uses, so reasons and shape are identical across transports and
  adjudicators.
- **alive** — the machine is up (live-but-slow exec, evicted execId, non-200s):
  the loop SHALL reset the consecutive count and resume polling, still bounded
  by the deadline.
- **inconclusive** — the underlying inspect threw (transient backend API
  error): the loop SHALL reset the consecutive count and resume polling; a
  failed probe is not a failed exec and SHALL NOT fail the workflow.

Poll outcomes alone SHALL never fail an exec: `unavailable` conflates
"unreachable" with "unknown execId / non-200", so the backend inspect is the
sole arbiter of dead versus live-but-slow. When no `isAlive` seam is wired
(bare loop invocation outside the client), the loop SHALL skip escalation and
retain pure deadline-bounded behaviour.

#### Scenario: Dead machine fast-fails the exec

- **GIVEN** a poll-mode exec whose sandbox machine dies mid-exec
- **WHEN** the threshold count of consecutive polls return `unavailable` and the probe step reports the machine observably dead
- **THEN** `awaitExec` SHALL return a synthetic-failure `ExecResult` with reason `"sandbox-dead"` without waiting for the deadline

#### Scenario: OOM-killed machine carries the OOM reason

- **GIVEN** a poll-mode exec whose machine the backend reports as OOM-killed
- **WHEN** the escalation probe runs
- **THEN** the returned synthetic-failure result SHALL carry reason `"sandbox-oom-killed"`

#### Scenario: Live-but-slow machine never escalates to failure

- **GIVEN** a poll-mode exec whose polls return `unavailable` past the threshold but whose machine the probe reports alive
- **WHEN** the probe verdict arrives
- **THEN** the loop SHALL reset the consecutive count and resume polling, and the exec SHALL remain bounded by the deadline only

#### Scenario: An ok poll resets the streak

- **GIVEN** a run of `unavailable` polls one short of the threshold
- **WHEN** the next poll returns a verified snapshot
- **THEN** no probe SHALL run and the count SHALL restart from zero

#### Scenario: A transient probe error is inconclusive

- **GIVEN** an armed escalation whose backend inspect throws a transient API error
- **WHEN** the probe step runs
- **THEN** the step SHALL NOT throw, the exec SHALL NOT fail, and the loop SHALL resume polling with the count reset

#### Scenario: Probes replay deterministically

- **GIVEN** a recovered workflow replaying a poll sequence that had escalated
- **WHEN** the loop replays over the checkpointed poll and probe steps
- **THEN** the same probes SHALL be issued at the same positions with the same step names, keeping the DBOS function-ID sequence stable

#### Scenario: No seam, no escalation

- **GIVEN** a poll loop invoked without an `isAlive` seam
- **WHEN** polls return `unavailable` past the threshold
- **THEN** the loop SHALL keep polling bounded by the deadline alone
