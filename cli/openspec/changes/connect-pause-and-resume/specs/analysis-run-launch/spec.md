## MODIFIED Requirements

### Requirement: The command blocks to a terminal state with live progress

The command MUST block until the run reaches a terminal status. The terminal statuses are `completed`, `partial`, `failed`, and `canceled`. A run with a paused step is not terminal, thus the command keeps waiting, and its progress MUST show each pause with its state and its cause. The durable workflow runs inside the DBOS runtime of the cli process. Thus an exit after the trigger would orphan the run until a future boot.

The command MUST show live progress while it blocks. It reads the per-step dispatch and completion from the harness's step-execution and workflow-progress records. A progress read is best-effort, and it MUST NOT abort the wait.

Each terminal status MUST map to a different outcome message. A failed or partial outcome MUST name the steps that failed.

If the user interrupts the wait with Ctrl+C, the command MUST detach with DBOS-recoverable semantics. The run is then marked recoverable and it resumes on a future runtime boot. The detach message MUST say so.

#### Scenario: Successful run reports completion

- **WHEN** every step completes and synthesis finishes
- **THEN** the command reports `completed` with the step list and exits cleanly (the process drains, with no hang)

#### Scenario: Step failure surfaces fail-fast outcome

- **WHEN** a step fails and the harness cancels the in-flight siblings
- **THEN** the command reports the run's terminal status and names each step that failed

#### Scenario: Ctrl+C detaches without killing the run's durability

- **WHEN** the user interrupts the blocking wait
- **THEN** the process exits after the DBOS shutdown marks the workflow recoverable, and the message names how to observe or resume it
