# Design

## Context

`runSeries` (`src/loop/run-loop.ts`) calls `streamText` with no `toolCallConcurrency`. At the end of a model response, the AI SDK runs each tool call of the response with no limit. `adaptTools` (`src/loop/tool-adapter.ts`) wraps each call in one DBOS step, and the step takes its function id before its first `await`. `edit_file` reads the file, replaces the text, and renames a new file over the target. Nothing orders two such calls.

## Goals / Non-Goals

**Goals:**

- The calls of one reply that change state run one at a time, in the order of the reply.
- A read-only call, a sub-agent, and a script keep their parallel run.
- A nested call of a script obeys the same order as a call of the model.

**Non-Goals:**

- An order between two runs, two sessions, or two hosts. Each series of requests has its own lock.
- A lock for each path. The per-path lock of opencode needs each writer to take the lock, and it does not order `execute_command`.
- An order between a read and a write of one reply. The AI SDK gives the calls of one reply as independent calls, and a rename is atomic. Thus a read sees the old file or the new file, not a part of a file.

## Decisions

- **The tool declares `concurrent`, and the default is `false`.** Codex (`supports_parallel_tool_calls`) and Claude Code (`isConcurrencySafe`) use the same default. A new tool runs alone until its author decides that it is safe.
- **One FIFO lock for each series, not a read/write lock.** A concurrent call takes no lock. Thus `run_script` can be concurrent, and its nested calls can take the lock with no deadlock. A read/write lock makes `run_script` hold the shared side while a nested call waits for the exclusive side.
- **`adaptTools` makes the lock.** The calls of one reply are in one series, and `adaptTools` runs one time for each series. A sub-agent runs its own loop, thus it gets its own lock.
- **The lock is in `ToolContext` as `callLock`, and the field is required.** `run_script` gives its context to each nested call. A required field makes a missing lock a type error, not a call that skips the order.
- **The wait is inside the step.** `runToolCall` runs inside the DBOS step of the call. The step takes its function id before the wait, thus a replay gives the same ids. A completed step replays from the cache and does not take the lock.
- **A tool that starts a workflow must be concurrent.** Such a call runs in the body of the workflow, and it must start the child before its first `await` (`ToolDefinition.startsWorkflow`). A wait for the lock breaks that rule. `defineTool` throws for `startsWorkflow: true` without `concurrent: true`.
- **The timer of a call starts when the call gets the lock.** The `tool-finished` event reports the time of the call itself (requirement "Each tool call is reported with its own outcome and duration").

## Risks / Trade-offs

- [A tool that is safe but not marked runs alone] → The cost is time, not a wrong result. The change marks each read-only tool.
- [A long call blocks the next call of the reply] → An agent has no reason to send two independent state changes in one reply.
- [A tool marked concurrent by mistake races again] → The flag is on the definition, beside `execute`, thus a review sees it.
