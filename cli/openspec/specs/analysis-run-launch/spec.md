# analysis-run-launch Specification

## Purpose
The deliberate `inflexa run` action that launches a full `executeAnalysis` run from a validated plan file: resolve the analysis, pre-flight (including validating the plan file), acquire the per-analysis instance lock, boot the embedded runtime, stage inputs, seed the ledger, persist the validated plan, and trigger — then block to a terminal run status with live progress, plus a read-only status view. This is the model-free replay path: it replicates the harness's own `executePlan` trigger flow because a file-driven launch has no chat turn to supply a live tool context (the conversation-agent path is `inflexa chat`). The replica's internals are absorbed by the daemon trigger endpoint at #33 M2. Lives in `src/modules/harness/run.ts`.

## Requirements

### Requirement: Launching an analysis run is a deliberate action

The system SHALL provide a dedicated command that launches a full `executeAnalysis`
run for a resolved analysis from a validated plan. The command SHALL sequence:
resolve the analysis reference → pre-flight prerequisite checks (the same actionable
gates as the profile launch: sandbox image, embedding endpoint, skills dir, proxy
key, model, Postgres) → validate the plan file (the pure parse/schema/`validatePlan`
gates, which persist nothing) → boot the embedded runtime → stage the analysis's
inputs into the session tree (mirror reconciliation; the run engine never downloads)
→ seed the harness analysis ledger row → persist the validated plan under its
deterministic id → trigger. Plan validation SHALL precede the boot so a malformed or
invalid plan is rejected before any side effect (no boot, no staging, no ledger row),
per the plan-intake spec; only the deterministic-id persistence needs the booted
pool. No passive flow (bare `inflexa` launch, TUI startup) SHALL stage, boot, or
trigger. An analysis with no resolvable inputs SHALL short-circuit before boot with
an actionable message.

#### Scenario: Full launch sequence on a prepared analysis

- **WHEN** the command runs for an analysis with resolvable inputs, a valid plan file, and satisfied prerequisites
- **THEN** inputs are staged under the session tree, the plan is persisted, and an `executeAnalysis` workflow is launched whose run row exists in the harness ledger

#### Scenario: Failed prerequisite is reported before side effects

- **WHEN** a prerequisite (e.g. sandbox image missing, embeddings endpoint unreachable) fails pre-flight
- **THEN** the command exits with that prerequisite's actionable message and neither staging, plan persistence, nor a run row was produced

#### Scenario: Invalid plan is rejected before boot

- **WHEN** the plan file is unreadable, not valid JSON, fails the plan schema, or fails `validatePlan` (cycle, unknown agent, missing resources, zero steps)
- **THEN** the command exits with the plan's actionable error before the runtime is booted — the runtime is never started, nothing is staged, and no ledger or plan row is written

#### Scenario: Missing completed data profile warns but does not block

- **WHEN** the analysis has no completed data profile in the harness ledger
- **THEN** the command surfaces a warning (agents orient on the profile summary) and proceeds with the launch

### Requirement: Trigger semantics match the harness's own plan-execution flow

The launch SHALL follow the same sequence the harness's `executePlan` tool performs,
using the harness's exported state functions and run launcher: dedup pre-check for
an active run of the same plan → reserve the run row before authorizing (the
partial-unique index is the race backstop; a dedup collision resolves to the
winner's run) → authorize through the local run authorizer → build the workflow
input from the plan (per-step rendered prompts, agent/resource/timeout maps, plan
summary from title or narrative) → launch with the workflow id equal to the run id.
On authorization or launch failure the reserved row SHALL be marked failed (and the
authorization revoked where one was issued) so a retry can re-run.

#### Scenario: Active run dedups instead of double-launching

- **WHEN** a launch is requested while a run for the same analysis and plan id is active
- **THEN** the command reports the existing run (id and status) and does not authorize or launch a second workflow

#### Scenario: Launch failure releases the dedup slot

- **WHEN** the workflow dispatch fails after the run row was reserved
- **THEN** the row is marked failed and a subsequent invocation can launch fresh

### Requirement: The command blocks to a terminal state with live progress

The command SHALL block until the run reaches a terminal status (`completed`,
`partial`, `failed`, `canceled`, `suspended_insufficient_funds`) — the durable
workflow executes inside the cli process's own DBOS runtime, so exiting after the
trigger would orphan it until a future boot — presenting live
progress (per-step dispatch/completion read from the harness's step-execution and
workflow-progress records; progress reads are best-effort and SHALL never abort the
wait). Each terminal status SHALL map to a distinct outcome message, with
failed/partial outcomes naming the failed steps. Interrupting the wait (Ctrl+C)
SHALL detach with DBOS-recoverable semantics — the run is marked recoverable and
resumes on a future runtime boot, and the detach message SHALL say so.

#### Scenario: Successful run reports completion

- **WHEN** every step completes and synthesis finishes
- **THEN** the command reports `completed` with the step list and exits cleanly (process drains; no hang)

#### Scenario: Step failure surfaces fail-fast outcome

- **WHEN** a step fails and the harness cancels in-flight siblings
- **THEN** the command reports the run's terminal status with the failed step(s) named

#### Scenario: Ctrl+C detaches without killing the run's durability

- **WHEN** the user interrupts the blocking wait
- **THEN** the process exits after DBOS shutdown marks the workflow recoverable, and the message names how to observe/resume it

### Requirement: Read-only run status view

The command SHALL offer a status mode that reports the analysis's runs and their
steps from the harness ledger without booting the runtime, provisioning anything, or
writing any state — reusing the live runtime's pool when one exists, else a
throwaway connection. Runs left by a dead process SHALL be annotated with the
resume-on-next-boot note.

#### Scenario: Status never boots

- **WHEN** the status mode is invoked with no runtime active
- **THEN** run and step states are reported (or "none") and no DBOS launch, listener, staging, or provisioning occurred

### Requirement: Kill/resume durability is verified end-to-end

The change SHALL verify DBOS crash recovery live for the embedded runtime: kill the
cli mid-workflow, boot again, and confirm the workflow resumes to a terminal state
and the status views reflect it. This is verified end-to-end for both durable
workflow types — the analysis-run path (`executeAnalysis`) and the data-profile path
(`runDataProfile`). Both are reclaimed by one recovery path — one runtime, executor
`local`, in-flight workflows resolved at launch by registered name — so a killed
workflow of either type is adopted on the next boot (`recovery_attempts` increments)
and driven to a terminal state under its original id, with the status views
reflecting the outcome.

#### Scenario: Killed run resumes on next boot

- **WHEN** the cli is killed while a run workflow is in flight and the cli later boots the runtime again
- **THEN** DBOS recovery resumes the run under the same run id, it reaches a terminal state, and the status view shows the outcome

#### Scenario: Killed data profile resumes on next boot

- **WHEN** the cli is killed while a data-profile workflow is in flight and the cli later boots the runtime again
- **THEN** DBOS recovery resumes the profile under the same workflow id, it reaches a terminal state, and `inflexa profile --status` shows the outcome
