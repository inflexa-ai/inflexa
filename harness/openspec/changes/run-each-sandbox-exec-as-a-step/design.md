## Context

Before this change, the harness split an exec in two. `submitExec` was a DBOS step. `awaitExec` ran in the workflow body, because the callback transport waited with `DBOS.recv`. The poll transport used the same body path: each poll was a durable step, and each pause was a durable sleep.

A watchdog workflow found a dead sandbox and sent a synthetic result to the topic of the exec. Each request and each response carried an HMAC signature with a per-sandbox secret.

The loop could not run `execute_command` in a step. Thus it ran each call of the `workflow` mode alone, after the parallel step calls. `write_file` and `edit_file` used the same mode, and they wrapped the disk write in `ToolContext.runStep`.

Three callers run an exec from a workflow body and not from a tool: the data profile, `derive-table-exec`, and `extract-values`.

## Goals / Non-Goals

**Goals:**

- One exec runs in one DBOS step, and the loop runs the sandbox tool calls of a round in parallel.
- One protocol: the host submits and polls. The sandbox initiates nothing.
- A recovered step attaches to the exec that already ran, and it does not run the command again.

**Non-Goals:**

- Durable exec records, and the restart in place of sandbox-server. #572 owns them.
- The long poll (`?wait=`) of #569. The poll is a short request.

## Decisions

### The exec id is the id of the step that runs the exec

The exec id is `${DBOS.workflowID}:${DBOS.stepID}`. DBOS makes the pair unique in a workflow, and the pair is the same on each run of the step. A caller mints no id.

A workflow body calls `exec` as its own step. A tool call of the loop is a step already, thus `exec` runs inside it and takes its id. The rule is one exec for each step. A second exec in the same step gets the same id, and the sandbox gives it the record of the first exec.

The issue proposed the `toolCallId` as the key. The step id covers the callers that are not tools: the data profile, `derive-table-exec`, and `extract-values` have no tool call.

### The poll loop runs inside the step

The step submits, then it polls with plain HTTP calls and plain timers. A poll writes no step row, thus the cadence can be short: 1.5 s for the first 40 polls, then 10 s. A completed step replays from the cache and sends no request.

A step that did not complete runs again from the start. The submit is idempotent on the exec id, thus the poll attaches to the exec that already ran or runs. The poll starts at cursor 0.

### Events go to the stream from inside the step

A write to a DBOS stream from a step is legal, and it is at-least-once. It takes no function id of the workflow. Thus a recovered step writes its events again, and the replay sequence of the body does not change.

A repeated event does no harm. The sandbox-step body folds each file-tree delta into one path set, and it writes the whole tree under one reconciling part id. A reader keeps the latest part for each id.

The issue proposed a reader that drops a known `(execId, seq)` pair. That is not necessary while each sandbox event becomes a whole-tree part.

### The step reads the cancel state

A DBOS step does not see a cancel of its workflow. The poll loop reads the status of its workflow at most each 10 s, and it throws `DBOSWorkflowCancelledError` on `CANCELLED`. The command in the sandbox continues until the reaper removes the machine, because sandbox-server has no kill route.

### The exec probes the liveness, and the watchdog is removed

Consecutive failed polls start one backend inspect. A dead machine ends the exec with a synthetic failure. An alive machine, or an inspect that throws, resets the count. The watchdog existed to give a synthetic result to a `DBOS.recv` that waited. No exec waits on a topic now, thus the watchdog is removed.

The reaper stays. It removes a machine whose workflow is terminal, for example after a cancel.

### sandbox-server keeps each record for the life of its process

A recovered step can come back after a long outage of Cortex. With a TTL, the record could expire, and a second submit would run the command again. Thus no TTL applies. A sandbox lives for one step, thus the life of the step bounds the records.

A restart of sandbox-server loses the records. Today no backend restarts a sandbox container: the K8s Job has no restart, and the Docker client sets no restart policy. A dead container gives a dead liveness verdict, and the exec ends with a synthetic failure. #572 adds durable records and the restart in place.

### No signature: confinement is the control

The sandbox initiates nothing, thus only the host must reach the exec port:

- On Docker, the port is published on `127.0.0.1` only. The entrypoint always installs the egress-deny firewall, thus a sibling sandbox cannot open a connection to this sandbox.
- On K8s, a NetworkPolicy of the deployment admits only Cortex to the sandbox port, and it denies all egress of the sandbox.

The secret, the request signature, and the response signature are removed.

### A tool is `step` or `inline`, and process state moves into a call record

`execute_command`, `write_file`, and `edit_file` run as step tools now. The loop caches the whole call. A replay returns the cached result, and it does not run the body. Thus a side effect of the body on process-local state is lost on recovery: the lineage collector of the step, and the provenance of a file-tool write.

The ok value of a tool carries a call record under a symbol key (`withToolCallRecord`). `JSON.stringify` omits a symbol key, thus the model never reads the record. The loop keeps the record in the cached dispatch. After the round, it gives each record to the `foldCallRecord` of its tool, in call order. The fold runs on the first run and on each replay. Thus the collector of a recovered step gets the same records in the same order.

`ToolContext.runStep` is removed. A step inside a step runs inline, thus the seam gave a tool nothing in a step.

### The `exec_id` column is dropped

The watchdog was the only reader of `cortex_step_executions.exec_id`, and its registry query was the only reader of the partial index `idx_cortex_step_exec_active_sandbox`. The migration `20261005120000_drop_the_active_exec_tracking` drops the column and the index.

### The notification sweep stays

A `DBOS.send` to a workflow that ends before it reads the message stays in `dbos.notifications`. The suspension notice of a child to a parent that failed is one example. The sweep removes such rows.

## Risks / Trade-offs

- A harness after this change and an image before it cannot work together. The old sandbox-server requires the secret, and it refuses an unsigned request. Ship the harness and the image together.
- A workflow that is in flight at the upgrade recorded the old step sequence (`sandbox.submit-exec.*` and the poll steps). Its replay under the new code can fail. Let the in-flight analyses end, or cancel them, before the upgrade.
- A round can run some `execute_command` calls at the same time in one sandbox. The calls share the cpu and the memory limit of that sandbox.
- After a recovery, the live file tree of a step holds only the deltas of the execs that ran in the new process. The terminal tree of the step corrects it at the end of the step.
- Confinement is the only control on the exec endpoints. A deployment that does not apply the NetworkPolicy on K8s exposes the exec port to each pod that can reach it.
