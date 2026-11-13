# Proposal

## Why

The loop runs all the tool calls of one reply at the same time. `streamText` sets no `toolCallConcurrency`, and the default of the AI SDK has no limit. Thus two `edit_file` calls on one file read the same content, and each call writes its own result over the file. One edit is lost, and each call gives `ok`. Run `3c075699` showed this in each step, and the agent used 5 to 11 more iterations in a step to find and do the lost edits again.

The same race applies to each tool that changes state: `write_file`, `edit_file`, `execute_command`, the decision record of a script, and the report-authoring tools. An agent has no reason to run two such calls at the same time.

## What Changes

- A tool declares `concurrent: true` when its calls can run at the same time as other calls. The default is `false`.
- The calls of one reply that are not concurrent run one at a time, in the order of the reply. A concurrent call does not wait.
- The order applies to one series of requests. Two runs, two sessions, or a sub-agent and its parent never wait for each other.
- A tool that starts a child workflow must be concurrent, because it must start the child before its first `await`. Thus sub-agents run at the same time.
- `run_script` is concurrent. Each nested call of a script obeys the order of the run that called the script.
- The duration of a call does not include the time that the call waits for its turn.

## Capabilities

### New Capabilities

### Modified Capabilities

- `harness-agent-loop`: a new requirement for the order of the calls of one reply.
- `harness-tools`: a new requirement for the `concurrent` declaration. The requirement "ToolContext carries only request-scoped values" gets the call lock, and it lists the fields that the context has now.
- `script-tools`: a new requirement for the order of a nested call.

## Impact

- `src/tools/define-tool.ts`: the `concurrent` field, the `callLock` of `ToolContext`, and the rule for a tool that starts a workflow.
- `src/loop/call-lock.ts`: the lock of one series.
- `src/loop/tool-adapter.ts`: each call that is not concurrent runs under the lock.
- `src/tools/script/run-script.ts`: each nested call that is not concurrent runs under the lock.
- Each read-only tool, each sub-agent tool, and `run_script` declare `concurrent: true`.
- A step agent that sends two `execute_command` calls in one reply now runs them one after the other.
