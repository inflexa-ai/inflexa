# Design

## Context

The change `pause-and-resume-work` added `CoreRuntime.pausedWork`. Its `list` reads only the rows of `cortex_paused_work`, thus it gives only the work that waits in a pause. A host that shows the work of an analysis must find a work that runs from other sources. The host also stops each kind through a different path: `chatTurns.stop` for a turn, and a run canceler that the host makes for a run. The harness has no stop of a data profile.

The turn workflow writes a `message-start` of the user id and of the assistant id before the first frame of the reply. The user `message-start` has no text. The turn stores the user message only with its first round. A client that attaches again before that round reads the stream from the start, but no frame gives the text of the user message.

## Goals / Non-Goals

**Goals:**

- One host surface that lists each active work of an analysis and stops it in each state.
- A stop of a data profile.
- A stream of a turn from which a reader can fold the user message.

**Non-Goals:**

- A change of `resume` or `hold`.
- A read of an old stored stream with the new schema.

## Decisions

### D1. The list gives each active work

`list(analysisId)` gives each active work of the analysis, one item for each work id. A workflow is active when its DBOS status is `PENDING` or `ENQUEUED`. The list finds each kind as follows:

- **Turn.** `queryTurnsOfAnalysis` gives the turn that holds each thread of the analysis. A claim of a thread can stay after its turn ends, thus the list keeps a turn only when its workflow is active.
- **Run.** `queryActiveRunsByAnalysis` gives each run whose row is `running`. The row is enough, because the run canceler also closes a row whose workflow ended. Thus the list shows a run that a stop can still close.
- **Profile.** The profile row gives `data_profile_workflow_id`. The list keeps the profile only when the row is `running` and that workflow is active.
- **Waiting workflow.** A pause row whose workflow is active also adds its work. Thus no wait is lost when the other sources do not find its work.

Each item holds each active waiting workflow of the work in `waiting`. A work that runs has an empty `waiting`. The list still deletes the pause row of an ended workflow.

A host that shows only paused work keeps the items whose `waiting` is not empty. The CLI does this.

Rejected: a separate `listActive` beside the old `list`. Two lists of one work give two sources of truth for one surface.

### D2. A stop for each kind

`stop(session, workId)` first reads the list of the analysis of the session. A work that is not in the list gives `not_found`: a work of a different analysis, an unknown id, or a work that ended. A found work gives `stopped` with its item. The stop then uses the path of its kind:

- **Turn.** `chatTurns.stop` of the runtime.
- **Run.** A run canceler that the runtime makes with `createRunCanceler`. The canceler gets the run charge, the run authorizer, and the provenance hook of the runtime. Thus the stop of a run closes the charge and revokes the mandate as a host cancel does. The cancel records the provenance `work-stop`.
- **Profile.** `stopDataProfile` (D3).

Each path ends the work when it runs and when it waits in a pause. Each path also deletes the pause rows of the work.

### D3. The stop of a data profile

`stopDataProfile(deps, analysisId, workflowId)` does these steps:

1. It cancels the profile workflow.
2. It deletes the pause rows of the profile.
3. It fails the profile row with the error `DATA_PROFILE_STOPPED` ("Data profiling was stopped"). The write changes only a `running` row. Thus a profile that settled first keeps its status.
4. It sends the settled notice, when the write changed the row.

The body passes the cancel through its failure path. It does not write the row. It revokes the mandate, because only the body holds the run session, and its `finally` tears down the sandbox. Thus the stop does the ledger work, and the body does the mandate and the sandbox work. A retry can start from the `failed` row, as after each other failure.

Rejected: a failure that the body writes. DBOS refuses each step of a canceled workflow, thus the body cannot write after the cancel.

### D4. The user message-start carries the text

`MessageStartEvent` is a union by `role`. The `user` variant has the necessary field `text`. The `assistant` variant has no text. The text is the sanitized user text, the same text that the model gets, thus the stream holds no secret that the model does not see.

`applyChatFrame` adds the user message `{ id, role: "user", parts: [{ type: "text", text }] }` when no message has that id. A client that already shows the user message under that id keeps it. A client that shows the user message under its own id gives the message the id of the stream first, as before.

The text is necessary, not optional. An optional text gives two kinds of frame, and each reader must examine the two kinds.

**Accepted break.** The stream of a turn that started before this release has a user `message-start` with no text. The new schema refuses that frame. The user accepted this break, and the change adds no read path for the old frame.

## Risks / Trade-offs

- **A stopped profile with no live body keeps its mandate.** DBOS does not recover a cancelled workflow. Thus if no process runs the body at the stop, nothing revokes, and the mandate stays suspended or ends with its window.
- **A list reads more sources.** The list reads the pause rows, the thread claims, the run rows, and the profile row of one analysis, and it does one DBOS status read. Each read is bounded by the work of one analysis.
- **The stop reads the list first.** A stop does the reads of a list before it ends the work. This keeps one definition of the work that a stop can reach.
