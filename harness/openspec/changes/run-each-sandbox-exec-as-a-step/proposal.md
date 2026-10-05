## Why

`execute_command` ran in the workflow body, because the callback transport waits for the result with `DBOS.recv`, and `DBOS.recv` is legal only in the body (#569). This choice had three costs:

- The loop ran each sandbox tool call one at a time.
- Each poll wrote a step row and a durable sleep. Thus the poll interval was 10 s after the first minute.
- Each host had to serve the callback ingress.

A write to a DBOS stream from a step is permitted, and it is at-least-once. Thus one DBOS step can hold the whole exec: the submit, the poll loop, and the events.

## What Changes

- Each sandbox exec runs inside one DBOS step, `sandbox.exec`. The exec id is `${workflowId}:${stepId}`, from the step that runs the exec. Thus one step holds one exec.
- The step submits `POST /exec`, then it polls `GET /exec/{execId}?since={cursor}`: each 1.5 s for the first 40 polls, then each 10 s. It gives the sandbox events to the stream from inside the step. It reads the cancel state each 10 s, it probes the liveness after failed polls, and it ends on the result or on the deadline.
- A recovered step submits again with the same exec id. sandbox-server dedups the submit and gives the existing record. sandbox-server keeps each record in memory for the life of its process, with no TTL.
- The status of a poll response is one of `running`, `completed`, and `failed`.
- A sandbox has no egress. On Docker, the exec port is published on `127.0.0.1` only, and the entrypoint always installs the egress-deny firewall. On K8s, a NetworkPolicy lets only Cortex reach the sandbox, and it blocks the egress of the sandbox.
- A tool runs in `step` mode or in `inline` mode. The ok value of a tool can carry a call record (`withToolCallRecord`). After each round, the loop folds the records in call order, on the first run and on each replay. `execute_command` folds its provenance frame into the lineage collector. `write_file` and `edit_file` fold their write records into provenance.
- **BREAKING**: these parts are removed:
  - the callback transport: `SandboxTransport`, `SANDBOX_TRANSPORT`, `CORTEX_BASE_URL`, and the exec-event delivery exports
  - the liveness watchdog: `registerWatchdog` and `queryActiveSandboxes`
  - the `"workflow"` tool execution mode, and `ToolContext.runStep`
  - the per-sandbox HMAC secret, and each request signature and response signature
  - the TTL of 1 h of a terminal exec record.
- **BREAKING**: the migration `20261005120000_drop_the_active_exec_tracking` drops the column `cortex_step_executions.exec_id` and the index `idx_cortex_step_exec_active_sandbox`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-sandbox-exec`: one exec in one step, the poll loop in the step, the cancel read, the liveness probe in the step, and no egress. The transport, the signatures, and the watchdog are removed.
- `sandbox-server`: one exec protocol with no signature and no callback, records for the life of the process, and the status enum.
- `docker-sandbox-provider`: the container always installs the egress firewall, and it gets no transport, no callback URL, and no secret.
- `sandbox-exec-logging`: the callback log lines and the watchdog summaries are removed, and the examples use the exec id of a step.
- `harness-tools`: the `workflow` mode and `ToolContext.runStep` are removed, and a tool ok value can carry a call record.
- `harness-agent-loop`: the dispatch has two modes, the loop folds the call records after each round, and a fatal error comes from a step tool.
- `structured-logging`: the example namespace is the sandbox reaper, not the watchdog.
- `analysis-purge`: the list of the scheduled workflows that a purge does not touch has no watchdog.
- `harness-workspace-tools`: `execute_command` takes its exec id from its step, and the file tools record their writes through the fold.
- `exec-provenance-lineage`: the exec frame reaches the collector through the fold.
- `step-execution-tracking`: the `exec_id` column and the `idx_cortex_step_exec_active_sandbox` index are removed.
- `run-event-stream`: the correct reason why the canceler writes no stream.
- `report-session-agent`: the derivation uses the exec protocol, which has no signature.
- `host-conversation-tools`: a host tool gets no `runStep`.

## Impact

- `src/sandbox/`: `exec.ts` replaces `submit-exec.ts`, `await-exec.ts`, `deliver-exec-event.ts`, `exec-id.ts`, and `digest.ts`. `watchdog.ts` and `hmac.ts` are removed. `client.ts`, `create-sandbox.ts`, `docker-client.ts`, `k8s-client.ts`, `identity.ts`, and `types.ts` change.
- `src/loop/run-agent.ts`, `src/tools/define-tool.ts`, `src/tools/workspace/`, `src/tasks/`, and `src/workflows/sandbox-step.ts`.
- `src/state/`: the new migration, and `active-sandboxes.ts`.
- `src/index.ts`: the removed exports. An embedder that wired the callback ingress or the watchdog must remove that wiring. The cli change `run-each-sandbox-exec-as-a-step` does this for the cli.
- `images/sandbox-base/server/`: no callback client, no signature, and no TTL. The harness and the image must ship together. An image before this change requires a secret and a signed request, and a harness after this change sends neither.
- #572 owns the durable exec records and the restart in place of sandbox-server.
