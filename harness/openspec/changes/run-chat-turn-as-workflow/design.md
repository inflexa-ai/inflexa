# Design

## Context

Stage 1 (`swap-agent-loop-for-ai-sdk`) runs each loop on `streamText`. Inside a DBOS workflow each model call and each tool call is a step. A chat turn is not a workflow. `runChatTurn` runs in the request of the host, and it streams through an emit sink. A round sink writes each round to Postgres, and an abort signal of the host stops the turn.

These facts constrain the design:

- A workflow input is serialized. A callback, the emit sink, the abort signal, and the provider cannot go into it. A credential of a request must not go into it (`harness-session-model`).
- A step cannot start a workflow, and it cannot call `DBOS.recv`. `DBOS.recv` and `DBOS.setEvent` run only in the workflow body.
- A write to a DBOS stream from the body is checkpointed and takes a function id. A write from a step is at-least-once and takes no id.
- `@dbos-inc/vercel-ai` lets one durable model call run at a time in one workflow. Two child workflows run in parallel.
- A DBOS cancel does not fire the abort signal of the AI SDK. The next DBOS call throws instead, thus the abort path of the loop does not run.
- The keys of a turn are random today when the session has no `RunFrame`: the usage keys and the references of the cut tool outputs.
- The round write takes its `seq` from the maximum. A rerun of a committed write appends the rows again.
- Only live events feed the display recorder. A replayed step emits nothing, thus a replayed round loses its display parts.

## Goals / Non-Goals

**Goals:**

- A crash of the host during a turn loses no completed call. A recovered turn continues, or it ends with a clear outcome.
- A client that loses its connection can read the turn again.
- Each sub-agent call is durable inside, and two sub-agents of one reply run at the same time.

**Non-Goals:**

- The pause and the resume of a turn or a run (stage 3). A recovered turn with no live credential ends as `interrupted` in this stage.
- A move of the readers to the AI SDK `UIMessageChunk`.
- A stop of a turn that runs on another replica of a host with more than one replica.
- The adaptation of Cortex. A later PR in its own repository does it.

## Decisions

### D1. The opening stays before the workflow

The host opens the turn in its request, as today: the preparation, the agent of the thread, and the opening rows. Then the harness starts the turn workflow. The workflow input holds only ids and settings: the turn id, the analysis, the thread, the user, the thread type, the author, the start time, the cache policy, and the model reference. The workflow id is the turn id.

The first step of the workflow loads the view of the conversation. Thus the raw user input never goes into a workflow input, and a refusal of the opening stays a synchronous answer to the host.

Rejected: the whole history as the input, because each turn stores the history again. Rejected: the opening inside the workflow, because a refusal then needs the stream.

### D2. The keys of a turn come from the turn id

A turn has no mandate, thus no `RunFrame`. Inside a workflow with no `RunFrame`, a key starts with the workflow id: the usage record, the reference of a cut tool output, and the compaction id. A sub-agent child workflow has its own id, `${parentId}-${toolCallId}`, thus its keys do not collide with the keys of its caller. Outside a workflow, a key stays random.

### D3. The host gives the live credential through a function

The host gives the runtime one function: `credentialFor(turn)` gives the `auth` of the turn, or nothing. The body calls it at its start, and after each wait. The body builds the session of the turn from its input and from that value. A child workflow gets the root turn id in its input, and it asks for the credential of the root turn.

Each host decides where the value comes from:

- The CLI has one local credential, thus its function always gives it. A recovered turn of the CLI continues.
- Cortex keeps the passport of each live request in the memory of the process. A recovered turn of Cortex finds no passport.

A body that gets nothing ends the turn as `failed` with the reason `interrupted`, before its next model call. Stage 3 changes that end to a pause.

Rejected: the credential in the input (decision Q5). Rejected: a mandate for each turn (decision Q5).

### D4. The turn uses the durable stream of the library, and the harness converts at its edge

The turn writes to the durable stream `chat` of its workflow with the writer of `@dbos-inc/vercel-ai`. Inside, the stream holds AI SDK `UIMessageChunk`s:

- `durableCalls` with the `durableStream` option writes the text of each model call from inside its step. The reader of the library drops the text of an attempt that a rerun replaced.
- `durableTools` with the `durableStream` option writes the record of each tool call. A tool step writes the facts of the harness through the tool writer of the library, as `data-*` chunks keyed by the tool call id:
  - at the start, a transient chunk with the detail of the call
  - at the end, a chunk with the outcome, the detail, and the duration
- The body writes its own facts as `data-*` chunks: the stored id of each assistant message, a refused call, a compaction part, a not-run answer at an exit, and the end with the usage of the turn or the reason of an error.
- The body closes the stream at the end of the turn.

The reader of the harness reads the stream with the reader of the library, and it converts each chunk to a `ChatFrame` at its edge. The converter drops the input and the output of each tool call, thus a client gets the same frames as before. A sub-agent child writes to its own stream. The stream of the caller holds a `data-*` chunk with the id of the child, and the reader merges the stream of each child. The source of each frame comes from the stream that it came from.

A reader reads a turn from its start, live, until its end. A client that connects again reads the turn again from its start and folds the frames again.

Trade-off: the stream keeps a second copy of the input and the output of each tool call, pictures included, beside the checkpoint of the step. The library writes text in batches of up to 20 parts or 25 ms.

Rejected: our own writer and reader of `ChatFrame`s. It builds again what the library gives: the writes from inside the step, the drop of a replaced attempt, the dedup of a rerun tool, and the read from an offset.

### D5. A stop goes through the process that runs the turn

The runtime keeps an in-process map from the turn id to an abort controller. The body puts its own controller at its start, thus a recovered body in a new process can also stop. `stop(turnId)` aborts that controller, and the abort path of the loop closes the turn as `aborted` with the partial text.

A process of this host can run no turn with that id. Then the stop cancels the workflow, and the harness closes the turn record as `aborted` outside the workflow.

### D6. Each write of a turn is safe to run again

- Each round write is a step. Its rows carry a key from the turn id and the index of the round. A unique index on the thread and that key makes a rerun of a committed write a no-op.
- The close write has its own key, and it is a step.
- The compaction reads its records in a step. The id of a compaction comes from `DBOS.randomUUID`, and its duration from `DBOS.now`.
- The display projection of a round comes from the frames of that round in the stream of the turn, inside the write step. A replayed step emits nothing, but its frames from the first attempt are in the stream.

### D7. One turn runs on a thread at a time

The opening refuses a turn when the thread has an open turn record. The refusal is `turn_in_progress`. A crash leaves the record open, and the recovery of the workflow closes it.

### D8. A sub-agent is a child workflow

Each sub-agent kind registers one workflow at the assembly: the literature reviewer, the planner, and the analogy reporter. The tool of the sub-agent starts the child with the id `${DBOS.workflowID}-${toolCallId}`, and it waits for the result. The tool does not run in a step, thus `durableTools` must leave it out. The start comes before the first `await` of the call. Thus the function ids of parallel calls do not depend on the order of the scheduler.

The child input holds the brief, the serializable parts of the session, the root turn id, the model reference, and the id of the call. A run gives its `RunSession`, which can go into a workflow input. The child returns its outcome and its usage, and the caller adds the usage to the total of the turn.

Outside a workflow, the tool runs the body of the child in its own process, as in stage 1.

The synthesis of a run leaves its outer step, thus its reviewers can start child workflows.

Rejected: `agentTool` of the library. Its child gets only the tool input, and it accepts only an SDK agent, not the driver of the harness.

### D9. An approval is decided before the tool runs

`defineTool` gets an optional approval hook: `approval(input, ctx)` gives a request or nothing. The hook can read the disk and the database (decision Q8). The `toolApproval` of the loop runs the call policy first, and then the hook.

When the hook gives a request:

1. A step looks for a grant. With no grant, it writes the ask row and the `data-ask` frame.
2. The body waits with `DBOS.recv` on the topic of the ask, up to the time limit of the ask.
3. The answer of the host goes to the turn with `DBOS.send`.
4. `once` and `always` let the call run. `reject` gives an `execution-denied` result with the feedback, and the turn stops, as in stage 1. A time-out gives `expired`, which reads as a denial.

`ctx.ask` goes. `run_inflexa` and `manage_inputs` of the CLI move to the hook. `execute` checks the input again, and it fails clean when a file changed after the approval. `web_fetch` asks nothing, and it refuses an internal address (decision Q9).

### D10. Each tool call that writes keys its write by the call

| Tool | Key | A rerun gives |
| --- | --- | --- |
| `update_working_memory` | the applied call keys, in the transaction of the edit | ok, and no change |
| `execute_analysis` | the run id, a UUIDv5 of `${workflowId}:${toolCallId}`. The launch enqueues with `DBOSClient` and the workflow id of the run. | the same run |
| `start_report_session` | the child thread id, a UUIDv5 of the step key. The row and the seed are one transaction. | the same session and its part |
| the authoring tools | a result row for the thread and the call, under a row lock | the stored result |
| `preview_report` | the part id from the call | the same part |
| `record_report_version` | the version id, a UUIDv5 of the step key | the same version |
| `derive_table`, the extraction | the exec id from the step, plus a hash of the request for an extraction | the same table |

### D11. A derivation runs inside its tool step

`derive_table` and the extraction of `preview_report` and `record_report_version` make the sandbox, run one exec, and remove the sandbox inside the step of the call. The sandbox name and the exec id come from the step, thus a rerun adopts the same container, and the sandbox server dedups the exec. A derivation mints no mandate (decision Q7). The workflows `derive-table-exec` and `extract-values` go.

### D12. A workflow takes its model from its input

The input of a turn, of a run, and of the data profile holds a model reference. The runtime resolves the provider from it. A change of the configured model does not change a turn or a run that started before the change. The CLI swap at idle changes the reference of the next turn.

### D13. The host surface

`CoreRuntime.chatTurns` gives the host these calls:

- `open(session, params)`: the opening. It gives the turn id or a refusal.
- `read(turnId)`: the frames of the turn, live, from the start.
- `stop(turnId)`
- `answer(askId, reply)`
- `outcome(turnId)`: how the turn ended, when its workflow ends. A failure gives a scrubbed text and a machine code, for example `credential`. The host maps the code to its remedy, because the cause stays in the workflow.

The in-process turn leaves the public surface. The test kit gives `inProcessChatTurns`, the same surface over the turn in the process of a test, thus the test of a host needs no workflow engine.

The CLI route opens the turn, starts to read, and serves the frames as SSE. A new route reads a turn again by its id.

## Risks / Trade-offs

- [The stream of a long turn grows with each text delta] → The model step writes the deltas in batches. A reader reads a turn only while it runs, or after a lost connection.
- [A rerun of a step writes its tool events again] → The fold of a tool call by its id is idempotent.
- [The in-process maps are lost on a restart] → The body puts its stop controller again. A host that keeps no credential across a restart gives nothing, and the turn ends as `interrupted`.
- [`execute_analysis` can mint a second mandate on a rerun] → The enqueue dedups the run. Thus no run uses the second mandate, and it expires at its time to live.
- [The library is 0.x] → The harness uses only `durableCalls` and `durableTools`. The child workflows and the stream are harness code.
- [A host with more than one replica cannot stop a turn of another replica in process] → The stop cancels the workflow and closes the record. Cortex adapts later.

## Migration Plan

1. The migrations add the round key of `messages`, the result table of the authoring calls, and the applied keys of the working memory.
2. A turn in flight at the update runs in a request, not in a workflow, thus the update ends it as today. The update runs during downtime, as for stage 1.
3. Rollback: revert the PR. The new columns and tables stay unused.
