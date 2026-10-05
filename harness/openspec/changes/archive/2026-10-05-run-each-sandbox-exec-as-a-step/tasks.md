# Tasks

Each path is relative to `harness/`, unless it starts with `images/`.

## 1. The exec step

- [x] 1.1 Add `src/sandbox/exec.ts` with the submit and the poll loop. The loop has the cadence of 1.5 s and 10 s, the event filter, and the gap warning. It reads the cancel state each 10 s, it escalates to a liveness probe, and it obeys the deadline.
- [x] 1.2 Replace `submitExec` and `awaitExec` of `SandboxClient` with `exec`, one `sandbox.exec` step with the exec id `${workflowId}:${stepId}`.
- [x] 1.3 Move each caller to `exec`: `execute_command` through `runSandboxExec`, `scan_inputs`, the data profile, `derive-table-exec`, and `extract-values`. Remove the function-id minters and the `execId` of `SandboxSpec`.
- [x] 1.4 Remove `await-exec.ts`, `submit-exec.ts`, `deliver-exec-event.ts`, `exec-id.ts`, `digest.ts`, and `watchdog.ts`, with their tests and their exports.
- [x] 1.5 Remove the HMAC: `hmac.ts`, the secret of `SandboxIdentity` and `SandboxRef`, and `SANDBOX_CALLBACK_SECRET` on each backend.
- [x] 1.6 Make the `status` of `PollResponseSchema` the enum `running`, `completed`, `failed`.
- [x] 1.7 Remove `SandboxTransport` and `CORTEX_BASE_URL` from each backend. The Docker backend always sets the firewall flag and the setup capabilities.

## 2. The tools and the loop

- [x] 2.1 Remove the `workflow` execution mode and `ToolContext.runStep`.
- [x] 2.2 Add `withToolCallRecord`, `readToolCallRecord`, and the `foldCallRecord` hook. Make the loop fold the records after each round, in call order.
- [x] 2.3 Make `execute_command` carry the record of its exec, and make its fold call `feedExecFrame`.
- [x] 2.4 Make `writeFile` give back the write record, add `recordWrite`, and make `write_file` and `edit_file` fold the record.

## 3. The state

- [x] 3.1 Add the migration `20261005120000_drop_the_active_exec_tracking`. Remove `execId` from `StepExecutionRow`, and remove `setActiveExecId` and `queryActiveSandboxes`.

## 4. sandbox-server

- [x] 4.1 Remove the callback client, `SANDBOX_TRANSPORT`, `CORTEX_BASE_URL`, `SANDBOX_CALLBACK_SECRET`, the inbound request check, and the response signature.
- [x] 4.2 Keep each exec record for the life of the process, with no TTL.
- [x] 4.3 Give a submit the answer `{ execId, status }`, with the status of the record.
- [x] 4.4 Update `images/sandbox-base/README.md` and the entrypoint comments.

## 5. The documents

- [x] 5.1 Update `CLAUDE.md`, `CONTEXT.md`, and `README.md` of the harness, the root `CONTEXT.md`, and `images/README.md` to the current state.

## 6. The Purpose sections

- [x] 6.1 Rewrite the Purpose sections that the deltas do not carry. Each of these named the transport, the signature, the watchdog, or the `workflow` mode:
  - `harness-sandbox-exec`
  - `sandbox-server`
  - `docker-sandbox-provider`
  - `sandbox-exec-logging`
  - `step-execution-tracking`
  - `harness-tools`
  - `harness-agent-loop`

## 7. The verification

- [x] 7.1 Run `tsc -p tsconfig.json` and `bun test` in `harness/`.
- [x] 7.2 Run `go test ./...` in `images/sandbox-base/server/`.
- [ ] 7.3 Rebuild the `sandbox-base` image, and run one analysis end to end on the Docker backend.
