# Design

## Context

Stage 2 (`run-chat-turn-as-workflow`) runs each chat turn and each sub-agent as a DBOS workflow. A run, its sandbox steps, and the data profile were workflows before. Each model call is a step of `durableCalls`, and the retry envelope of the provider retries a transient failure inside that step.

A failure after the retries ends the work in two ways today:

- A chat turn fails. The failure code is the suspend reason of the host, `credential`, `outage`, `internal`, or `interrupted`.
- A run, a sandbox step, and the data profile "suspend". They record the reason, mark the analysis `suspended_insufficient_funds`, and call `cancelSelf` (`workflows/suspension.ts:48`).

No code resumes a suspended workflow. `DBOS.resumeWorkflow` has no caller, and `resumeAnalysis` has no caller (`state/analyses.ts:72`). The spec of the run end calls the resume "a DEFERRED enhancement" (`workflow-failure-lifecycle`). A resume also cannot work under DBOS 5. DBOS records no cancel that a workflow makes of itself, thus a resume runs the body into the same `cancelSelf`. The failed model step also replays its recorded error, thus a resume never sends the request again.

The decisions of 2026-10-26 (`tmp/claude/tool-review.md`) set the behavior:

- A failure that a person or time can repair leaves the work in a state that the user can resume. This applies to a chat turn and to a run.
- Two states. In `retrying`, the system owns the work. In `paused`, the user owns the work.
- Only a client starts a resume from `paused`.
- A recovery after a crash is not a resume. A chat turn has no credential after a crash, thus it goes to `paused`.
- Sandbox internals are out of scope.

## Goals / Non-Goals

**Goals:**

- One pause mechanism for each kind of durable work: a chat turn, a sub-agent of a turn, a run with its steps and its synthesis, and the data profile.
- A pause that survives a crash and a restart of the host.
- A host surface to list the paused work of an analysis and to resume it.
- The removal of the suspended state, the self-cancel, and the code that only served them.

**Non-Goals:**

- A pause before the work starts. A refused authorization of a run or of a data profile stays a refusal.
- A pause of work inside a step. A derivation and an extraction keep the refusal as a value of the tool.
- A change of the sandbox. A paused step keeps its sandbox, as a suspended step does today.
- A pause of an embedding call. The index stages degrade on a failure, as today.
- A notice to `RunCharge` at a pause or at a resume.

## Decisions

### D1. A pause is a durable wait inside the workflow

The workflow that meets the cause waits with `DBOS.recv` on a topic of its own pause. It does not cancel itself. The workflow stays `PENDING`. A recovery after a crash replays the body to the same wait, because the checkpoints hold the failed step and the steps of the pause.

`cancelSelf` goes. A workflow never ends `CANCELLED` for a cause of a pause.

Rejected: a cancel and `DBOS.resumeWorkflow`. DBOS 5 does not record the self-cancel, and the failed model step replays its error, thus the resume cannot send the request again. Rejected: a fork of the workflow from the failed step. A fork makes a new workflow id, thus each key of a turn and of a run changes.

### D2. The causes of a pause

The work pauses for these causes, and only for these:

| Cause | Source | First state |
| --- | --- | --- |
| `outage` | a `provider` error with `retryable: true`, after the retries of the envelope | `retrying` |
| `host` | a `suspend` error of a model request, or a gate refusal with `suspend: true` | `paused` |
| `credential` | an `auth` error of a model request, or a turn with no credential | `paused` |

The cause of `host` carries the reason of the host, unread. Each other failure fails the work as today. The harness selects a cause from the kind of the error or from the flag, never from the text of a message.

### D3. The loop pauses at the failed request

The loop catches the failure of a request series. When the loop runs in workflow code and the failure has a cause, the loop waits in the pause. After the resume, it runs the series again with the requests that the series did not use. The completed steps of the series stay in the conversation.

A live call that failed after its first output part leaves a partial reply. The loop keeps that reply as an interrupted reply, the same as the abort path does. Then it appends one harness request that asks the model to continue. A call with no live reader takes the whole reply inside its step, thus it leaves no partial reply. In that case the loop sends the same request view again, and the prompt cache matches its prefix.

The loop does not pause outside a workflow, or inside a step. There the failure leaves as a throw, as today. Thus a derivation and an extraction inside a tool step keep their current behavior.

Rejected: a pause in a model middleware outside `durableCalls`. A failure after the first output part reaches the middleware inside the stream. The middleware cannot take back the parts that it gave to `streamText`.

### D4. A gate refusal with the suspend flag pauses at the gate

Inside a workflow, a gate that refuses with `suspend: true` pauses the work. After the resume, the work calls the gate again. These gates are inside a workflow:

- `RunCharge.open` in `validateAndInit` of a run
- the label gate of a sandbox spawn, in a sandbox step and in the data profile
- `ArtifactRegistry.register` in a sandbox step

`RunAuthorizer.authorize` runs before a run or a data profile starts. No work exists yet, thus its refusal stays a refusal. The run row goes to `failed`, and the profile row goes to `failed`, with the reason of the host. Neither marks the analysis.

### D5. Two states and the timer

A pause with the cause `outage` starts in `retrying`. The wait has a deadline from `DBOS.now()`, thus a recovery keeps the same deadline. At the deadline, the work sends the request again. The delays of the default schedule are 1, 5, 15, and 30 minutes. After the last delay, the pause goes to `paused`.

A host can give its own schedule with `pauseRetryDelaysMs` in the deps of the runtime. An empty schedule sends an outage to `paused` at once.

A pause with the cause `host` or `credential` starts in `paused`. The wait has no deadline. Only a resume ends it.

A new failure after a resume starts a new pause. Its count of timer attempts starts again at zero.

### D6. The record of a pause and the part of a pause

Each waiting workflow writes one row in the new table `cortex_paused_work`, in a step, before it waits. The resume of the workflow and the stop of its work delete the row. The row holds:

- `workflow_id`, the key
- `work_id` and `work_kind`: the turn id, the run id, or the id of the profile workflow, and `turn`, `run`, or `profile`
- `analysis_id`, and `thread_id` for a turn
- `state`, `cause`, `attempt`, and `retry_at`
- `topic`, the topic of the resume message
- `paused_at`

The workflow also writes a `data-pause` part to the stream of its work. The part holds the workflow id, the state, the cause, the attempt, and the next retry. A resume writes the part again with the state `running`. The registry marks the part as reconciling, thus a reader keeps the latest part of each workflow.

The row is the truth for a reader that comes later, for example a client after a restart. The part is the notice for a live reader. This settles the open question of 2026-10-26 about parts and state.

A sub-agent of a turn and a sandbox step of a run write the work id of their root. Thus a host lists and resumes the work as one item.

### D7. The resume

`CoreRuntime.pausedWork` gives these two calls:

```ts
type PauseCause = { kind: "outage" } | { kind: "credential" } | { kind: "host"; reason: string };

type PausedWork = {
    workId: string;
    kind: "turn" | "run" | "profile";
    analysisId: string;
    threadId?: string;
    waiting: { workflowId: string; state: "retrying" | "paused"; cause: PauseCause; attempt: number; retryAt?: string; pausedAt: string }[];
};

pausedWork.list(analysisId): Promise<PausedWork[]>;
pausedWork.resume(session, workId): Promise<{ kind: "resumed"; workflows: number } | { kind: "not_found" }>;
```

`resume` sends one message to the topic of each waiting workflow of the work. The topic holds the id of the pause, and the send has an idempotency key from that id. Thus a message never wakes a later pause, and a second resume sends nothing new. A work of a different analysis than the session gives `not_found`.

The same call ends a wait in `retrying`. Thus "retry now" and "resume" are one call.

For a turn, `resume` first puts the credential of the session for the turn, the same as `open`. A host with more than one process gives the credential through `credentialFor`.

`list` skips and deletes a row whose workflow is no longer active. Thus a row that a crash or an outside cancel left behind does not show.

Rejected: a resume that the server starts by itself, for example after a top-up. The decisions of 2026-10-26 give the resume to the client only.

### D8. A stop of paused work

The stop of a turn and the cancel of a run end paused work, and they delete the rows of the work. The stop of a turn in the process that runs it aborts the wait, the same as it aborts the wait of an ask. The turn then closes as `aborted`. The cancel of a run cancels the workflows with their children, as today.

### D9. A chat turn reads its credential before each request

The turn reads the credential of its host before each model request, not only at the start of the body. With no credential, the request fails with the cause `credential`, and the turn pauses. After a resume, the turn reads the credential that the resume put. Each later call of the turn uses it.

This replaces the end `interrupted`. A turn workflow fails with the code `provider` or `internal`. `provider` names a provider error that no person or time can repair, for example a refused request with the status `400`. A turn with no workflow, for example the turn of the test kit, cannot pause. Thus it still fails with the suspend reason of the host, `credential`, or `outage`.

### D10. A run with a paused step

A sandbox step pauses in its own workflow. The parent waits for the result of the child, as for a step that runs. The other steps continue, and each pauses at its own failure. The run row stays `running`, and the step row stays `running`. A reader finds the pause in `cortex_paused_work`.

A paused run is an active run. Thus it blocks a new run of its plan, and a launch of the plan gives the paused run. The user resumes it or stops it.

These parts go:

- the run status and the analysis status `suspended_insufficient_funds`
- `suspendAnalysis`, `resumeAnalysis`, and the suspended branch of `collectAndComplete`
- the topic `child-suspended`, and the cancel of the siblings of a suspended step
- the outcome `{ kind: "suspended", reason }` of `RunCharge.close`
- the revoke reasons `workflow-suspended` and `data-profile-suspended`

A versioned migration moves each run row `suspended_insufficient_funds` to `failed`, with its error unchanged. Those workflows ended `CANCELLED`, and nothing can resume them. The migration moves each analysis row `suspended_insufficient_funds` to `active`.

### D11. The clock of a sub-agent runs during a pause

The planner bounds its run with a clock of the process (`AbortSignal.timeout`). A pause does not stop that clock. A pause past the clock ends the sub-agent with its timeout outcome. A literature reviewer and the analogy reporter have no clock.

Rejected: a clock that stops during a pause. It needs a durable clock, and the planner changes soon.

### D12. The park of a long pause is a later change

A waiting workflow stays in the memory of its process. Its `recv` makes two queries each 10 s, and a restart replays it to its wait. For a short pause, this cost is small.

A later change can park a long pause. The server cancels the workflow from outside while it waits in `paused`. DBOS records a `recv` only when it consumes a message, thus the wait leaves no record. To resume parked work, the harness sends the message, and then it calls `DBOS.resumeWorkflow` for each parked workflow of the work. The replay then reaches the same `recv`, which finds the message. A parked workflow does not load at startup.

That change must tell a parked workflow from a stopped one, because each is `CANCELLED`. It must also resume each workflow of the work, because `resumeWorkflow` resumes one workflow only. The wait of this change does not change for it.

### D13. One application version, and a patch for a change of a workflow body

DBOS recovers a workflow only in a process with the same application version. With no version from the host, DBOS makes the version from the source text of each registered workflow function and from its own version. Thus an upgrade of DBOS leaves each paused workflow with no process that recovers it. A pause can last days, thus an upgrade during a pause is a usual event.

`launchDbos` sets `enablePatching`. DBOS then keeps one version, `PATCHING_ENABLED`, across upgrades. A replay compares the name of each recorded operation with the name that the code calls at the same position. Thus a change inside a step needs nothing, for example a prompt, the code of a tool, or a model. A change of the operations of a workflow body before a wait uses `DBOS.patch`, and only a new execution takes the new path. A host that gives its own `applicationVersion` keeps it, and it then owns the recovery across its upgrades.

Rejected: a version for each build. It leaves each paused workflow behind at each upgrade.

## Risks / Trade-offs

- A paused step keeps its sandbox. A long pause holds a container. The planned sandbox changes of the owner (#572) remove an idle sandbox.
- A paused turn holds the claim of its thread. A second message gets `turn_in_progress` until the user resumes or stops the turn.
- A sibling step of a run with no funds continues its sandbox commands until its next model request pauses it. Today the parent cancels the siblings.
- A process clock of a sub-agent counts the time of a pause (D11).
- A wait in `paused` loops on `DBOS.recv` with a long timeout. Each timeout adds one checkpoint, for example one each day.
- Cortex depends on the removed run status, on the removed charge outcome, and on `suspensionOfFailure`. A later PR in its own repository adapts it.

## Migration Plan

- Deploy during downtime, as for stage 2. A workflow that is suspended at the update ended `CANCELLED`, and the migration moves its row to `failed`.
- The migration of the new table and the migration of the old rows run with the other versioned migrations at startup.
- Order of the merges: this change comes after `run-chat-turn-as-workflow`. Its deltas of `chat-turn` change requirements that the stage 2 change adds.
