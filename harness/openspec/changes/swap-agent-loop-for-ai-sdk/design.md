# Design

## Context

See `proposal.md` for the reason. The facts that shape the approach:

- Only two loops run inside a DBOS workflow today: the sandbox step agent (`workflows/sandbox-step.ts`) and the data profiler (`tasks/data-profile.ts`). Each other loop runs in process: the chat turn, the sub-agents inside a tool, the synthesis inside one `DBOS.runStep`, and the post-step continuations inside one step each.
- `@dbos-inc/vercel-ai` (`durableCalls`, `durableTools`) makes a step only inside a workflow. Outside a workflow it calls the model and the tool directly. Inside a step it also calls them directly, with no checkpoint. Thus one loop serves each context.
- The library lets one durable model call run at a time in a workflow (`middleware.ts:33-50`). Each durable loop of this change has one conversation for each workflow.
- `activeTools` removes tools from the provider request (`ai/src/generate-text/stream-text.ts:2350-2353`). Thus it breaks the cached prefix, and this design never uses it.
- The SDK starts the tool calls of one reply together, in stream order. DBOS needs concurrent operations to start in a fixed order. Thus each tool is one step, and no tool runs in the workflow body.
- The library stores no conversation. The `messages` table stays the transcript.

## Goals / Non-Goals

**Goals:**

- One loop on `streamText` for each context, with each harness behavior of `specs/harness-agent-loop/spec.md`.
- Each tool is a plain step: its result carries each fact that a caller reads later, and a rerun of its body is safe.
- Stages 2 and 3 (the durable chat turn, pause and resume) need no rework of this stage.

**Non-Goals:**

- The durable chat turn, `agentTool` sub-agents, the move of `ctx.ask` to `toolApproval`, the pause, and the resume.
- The sandbox internals: the exec, `scan_inputs`, the decision record of a script, and the derivations. A separate plan covers them.
- A port of the old loop unit tests. New tests cover the behaviors of the specs.

## Decisions

### D1. `streamText` with a thin driver, not `ToolLoopAgent`

The driver calls `streamText` with `stopWhen`, `prepareStep`, `toolApproval`, and `repairToolCall`. `ToolLoopAgent` has no `onChunk`, `onError`, or `onAbort`, and the chat turn uses each of them.

The driver keeps only the work that the SDK does not do:

- the salvage request
- the follow-up request
- the compaction
- the round sink
- the mapping of the events
- the finish record
- the answer of each unanswered call at an exit

Each salvage and each follow-up request is one more `streamText` call over the same system prompt, tools, and provider options.

Alternative: keep `runAgent` and call the library helpers from it. Rejected, because the issue asks for the removal of the hand-rolled loop.

### D2. Durability through the library, with fixed step names

- The model gets `durableCalls` with a fixed `name`, thus the identity of a step holds no model id.
- The tools get `durableTools`, with retries off (the library default).
- A workflow takes its model configuration from its own input. Thus a change of the configured model never breaks a replay.

The old step names go. A workflow in flight at the switch cannot replay, and the switch runs during downtime.

### D3. One retry layer, inside the model step

DBOS step retries stay off for model calls. Two layers would multiply the attempts. The model call retries a transient failure inside its step, with the AI SDK `maxRetries` and a bounded count.

The implementing agent must confirm in the versioned AI SDK docs that `maxRetries` reads `Retry-After`. If it does not, a small model middleware does the retry.

After the last attempt, one classifier names the class of the failure:

- a provider outage
- a billing refusal (the `suspendOn` map of the host)
- a missing or invalid credential
- another failure

Each class keeps the outcome that it has today. Stage 3 adds the pause at this one point.

### D4. `defineTool` stays, with one adapter to AI SDK `tool()`

`defineTool` keeps its shape, thus each tool and each host tool keep their code. One adapter makes the AI SDK tool. The adapter:

- runs `execute` with the same `ToolContext`
- maps an `err` and a throw to an error result
- puts the value, the call record, and the pictures in one plain JSON output, thus the checkpoint keeps them
- cuts a long result inside the step, thus the step output holds the excerpt
- emits the `tool-started` and `tool-finished` events inside the step (see D9)

`toModelOutput` gives the model its view: the JSON text, or the excerpt, then the pictures when the provider carries them. The model never reads the call record.

### D5. Policy refusals through `toolApproval`

One approval function per run applies the mask, the budget, and the guard of the planner. It counts the calls from the steps of the run. A refused call gets `denied` with the same reason text as today. The model then gets an `execution-denied` result, and the declared tools stay the same.

A policy refusal does not stop the turn. Only the denial of the user stops the turn.

In this stage, `ctx.ask` still runs inside `execute`. A rejection becomes an `execution-denied` output through `toModelOutput`, and the stop condition stops the turn on that output. The two denials stay apart by their source.

### D6. Outcomes from the recorded tool results

- Each submit tool is a pure check that returns `accepted` with the payload, or the issues.
- Each agent has one pure selector over `steps[].toolCalls` and `steps[].toolResults`. `stopWhen` and the caller use the same selector.
- A replay rebuilds `steps` from the checkpoints, thus the selection is the same.
- The holders, the cells, `resolved`, and the call guard wrappers go.
- The side effect of an outcome comes after the selection, in the caller: the persist of a plan, and the resolution of a profile. Each uses an id that a rerun gives again, for example `upsertPlan` with an id from the call.

### D7. Compaction in `prepareStep`

`prepareStep` reads the latest input tokens. Over the budget, it runs the compaction exchange as a follow-up request (D1), and it returns the new view as `messages`. Messages that `prepareStep` adds are not in `responseMessages`, thus the driver records them for the round sink and for the result. A durable loop gives no policy, as today.

### D8. The model view of a picture

`toModelOutput` puts the pictures in the tool result only when the capability `imageToolResults` is set. Otherwise the pictures drop, and one warn gives the count. The OpenAI chat and the OpenAI-compatible wire would send the bytes as JSON text. The placement in a user message goes, because no wired provider sets `imageUserMessages`.

### D9. Each event of a durable loop is written inside a step

A write to a DBOS stream from the workflow body takes a function id. A callback before `execute` can then change the order of the steps on a replay. Thus the tool events are written inside the tool step (D4), and the model output is written inside the model step. A write from a step is at-least-once. Each reader already keeps the latest part for each id.

### D10. A usage record keys on the response id

A usage record keys on the run frame, the call path, the invocation id, and the id of the model response. The library keeps the response id the same on a replay. The counters grow inside the model step, thus a replay does not count again.

### D11. The chat turn makes its own transport values

The chat turn makes these values from the runtime: the model, the text stream (from `onChunk`), the usage recorder, and the approval binding. The ask gateway moves into the runtime, over the pool of the runtime. The host keeps its HTTP routes, which answer, list, and sweep the asks through `runtime.askGateway`.

`runAgent`, `RunStep`, `passthroughStep`, `durableStep`, `createStreamingChat`, and `AgentChat` leave the barrel. The tests of the CLI that drive the loop move to a harness test kit.

### D12. The report agent asks for one call at a time

The report agent sets the provider option for one tool call per reply: `disableParallelToolUse` on Anthropic, and `parallelToolCalls: false` on OpenAI. The option is part of the agent definition, thus each request of the conversation sends it.

### D13. `edit_file` records its intent, and each write is atomic

Inside a workflow, `edit_file` inserts an intent row before it writes. The row is keyed `${workflowId}:${stepId}`, and it holds the path, the hash before, the hash after, and the result.

On a rerun, the current hash of the file decides the action:

- the hash after: give back the stored result
- the hash before: apply the edit
- another hash: give a conflict

Outside a workflow, nothing reruns, thus no row is written. The mutator writes each file to a temporary file in the same directory, named from the key, and renames it over the target. This also applies to `write_file`.

A DBOS datasource transaction cannot run inside a step, and it does not cover a file. Two workflow-level steps for one edit would run in the workflow body, where parallel calls start in a random order. Thus both options are rejected.

### D14. The terminal-tool agents drop the wrap-up and the truncation recovery

At the step cap a run ends. A reply cut at the output limit ends the run, and each unanswered call gets its not-run result. The bench runs show if either recovery is necessary. When a run ends with no outcome, the salvage of D1 runs.

### D15. Constraints for the next two stages

- **One classifier.** Each failure that time or a person can repair goes through the classifier of D3.
- **No new cancellation.** No new path cancels its own workflow to suspend (`cancelSelf`).
- **No new durable credential.** No new durable input carries a `RequestSession` or a credential of a request.
- **Reads have no side effects.** A read of a stream never starts work.

### D16. Dependencies

- `@dbos-inc/dbos-sdk` moves to the latest 5.x, which is 5.1 or later. The implementing agent reads the release notes of DBOS 5, and it adapts the boot, the registration, and the test rig.
- `@dbos-inc/vercel-ai` joins at an exact version.
- `ai` stays on 7. A bump inside 7 is permitted when the library needs it.

### D17. Specs that name a removed function

Other specs name `runToTerminal`, `continueAgent`, `runAgent`, or step names, for example `literature-reviewer`, `step-interpretation-summary`, `harness-sandbox-agents`, and `harness-sandbox-exec`. The implementing agent edits those names directly in `openspec/specs/`, with no delta, when the code lands. The behavior does not change.

## Risks / Trade-offs

- **The library is pre-1.0 and has one maintainer.** → Pin the exact version. The source is about 1,700 lines, thus a fork is cheap.
- **Messages from `prepareStep` are not in `responseMessages`.** → The driver records each message that it adds. A test asserts that the stored transcript equals the sent prefix.
- **The SDK writes `{}` into the history for a tool input that is not an object** (`to-response-messages.ts:94`). The history then differs from the output of the model. → The bench runs watch the cache read rate and the thinking blocks after a cut reply.
- **A workflow in flight at the switch fails its replay.** → Switch during downtime, and drain or fail the open workflows first.
- **An event written inside a step can arrive two times.** → Each event keys on the tool call id, and each reader keeps the latest part.
- **Truncation recovery and the wrap-up go.** → A capped chat turn can end on tool results with no text. The bench runs decide if the wrap-up comes back.

## Migration Plan

1. Bump DBOS, and add the library and its pin.
2. Land the loop, the adapter, and the tool changes with their tests.
3. Adapt the CLI in the same PR. Cortex adapts in a follow-up PR.
4. Before the deploy, drain the open workflows. Add the migration of the intent table.
5. To roll back, revert the PR. A workflow that started on the new loop cannot replay on the old loop.

## Open Questions

- The retry count and the backoff of a model call. The bench runs tune them.
