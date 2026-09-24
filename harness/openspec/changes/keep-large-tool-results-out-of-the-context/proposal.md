## Why

Each agent conversation is append-only. A record is final when the harness first sends it, and no later step changes the history. Thus a large tool result stays in each later request of its conversation, and the harness can shorten it only before the first send.

The loop has no general limit on the size of a result. `successResult` (`src/loop/run-agent.ts` near line 971) turns each value into a tool message. `read_file` gives up to 256 KiB (`src/tools/workspace/read-file.ts` line 19).

The sandbox keeps only 32 KiB of each stream of a command, and it drops the rest. The host sends that value as a retention budget (`src/sandbox/submit-exec.ts` near line 89). Thus the end of a long output, where the errors are, never reaches the host.

## What Changes

- The loop cuts each tool result whose text is longer than 32,768 characters, before the result joins the transcript. The model gets an excerpt: the start, the end, the total length, and a reference.
- The loop does the cut in `dispatchTool`, thus each tool gets it, and no tool gets its own code for it.
- A new interface, the tool output store, keeps the full text of a cut result. `RunAgentOptions` gets the optional field `toolOutputStore`, the same way as `usageRecorder`.
- Without a store, the loop cuts, and the excerpt states that the rest is not kept.
- A new table, `cortex_tool_outputs`, holds each kept text under the analysis id and the reference. A text of a chat turn also names its thread.
- The analysis purge deletes the rows of the analysis. A thread purge deletes the rows of each thread that it removes.
- A new tool, `read_tool_output`, reads a kept text by its reference: a window of characters, or the matches of a pattern. Each agent with a tool declares it.
- The two post-step continuations let `read_tool_output` run, beside `read_file` and `grep`.
- The sandbox gets a budget of 1 MiB for each stream, the maximum of the store. Thus the full stream reaches the host, and the loop decides what the model sees.
- The description of `execute_command` states the new budget and the excerpt.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-agent-loop`: the cut of a long result, the excerpt, and the optional store of the kept text.
- `harness-tools`: the tool `read_tool_output`, and the rule that each agent with a tool declares it.
- `harness-workspace-tools`: the bound of each stream of `execute_command` becomes the maximum of the store.
- `harness-sandbox-exec`: the host sends a stream budget of 1 MiB, and it cuts each stream at that budget on receipt.
- `sandbox-server`: the completion payload keeps each stream up to the budget of the submit, with the truncation flag and the total.
- `postgres-storage-backend`: the table `cortex_tool_outputs` and its Postgres realization.
- `analysis-purge`: the purge also removes the kept tool outputs.
- `harness-thread-store`: a hard delete also removes the kept tool outputs of each thread of the subtree.
- `harness-durable-runtime`: the composition root gives one store to each loop and to each read tool.
- `harness-sandbox-agents`: the substrate declares `read_tool_output`, and the two post-step masks let it run.
- `per-agent-tool-allowlist`: the substrate names `read_tool_output`.
- `step-interpretation-summary`: the mask of the summary continuation lets `read_tool_output` run.
- `literature-reviewer`: the literature reviewer and the run synthesizer declare `read_tool_output`.

## Impact

Harness source:

- `src/loop/run-agent.ts` and the new `src/loop/tool-output.ts`.
- The new `src/state/tool-outputs.ts`, and `src/state/init.ts`, `src/state/purge-analysis.ts`, and `src/memory/thread-store.ts`.
- The new `src/tools/read-tool-output.ts`.
- The agent compositions: `src/agents/conversation-agent.ts`, `src/agents/report-session-agent.ts`, `src/agents/sandbox/shared.ts`, `src/tools/research/generate-plan.ts`, `src/tools/research/generate-analogy-report.ts`, `src/tools/research/literature-reviewer.ts`, and `src/execution/run-synthesis.ts`.
- The wiring: `src/runtime/assemble.ts`, `src/app/chat-turn.ts`, `src/app/synthesize-run.ts`, `src/workflows/sandbox-step.ts`, `src/workflows/execute-analysis.ts`, `src/execution/post-step-pipeline.ts`, and `src/tasks/data-profile.ts`.
- The masks of the two post-step continuations: `src/execution/artifact-metadata.ts` and `src/execution/step-summary.ts`.
- The stream budget: `src/tools/workspace/result-bounds.ts`, `src/tools/workspace/execute-command.ts`, `src/sandbox/submit-exec.ts`, and `src/sandbox/create-sandbox.ts`.
- `src/index.ts`, `CONTEXT.md`, and `CLAUDE.md`.

Database: the new table `cortex_tool_outputs` and its partial index on `thread_id`. The state initialization makes them at startup. No backfill runs.

Sandbox server: no code change. The server already keeps the start of each stream up to the budget of the submit.

Consumers:

- `SandboxAgentBuildContext` gets the optional field `toolOutputStore`. An embedder gives it to `SandboxAgentDeps` in its `buildAgent`. Without it, the sandbox agents of that embedder do not declare `read_tool_output`, and the loop keeps no text for them.
- `cli/src/modules/harness/run_deps.ts` gives the store to the agent, and `run_deps.test.ts` adds the field to its build context. CI links the working-copy harness, thus the two files change in this change.
- Cortex gives the store in its `buildAgent` when it bumps the pin.
- Each caller of the sandbox client gets streams of up to 1 MiB. The value extraction and the input scan read the longer stdout.

Dependencies: this change builds on `keep-each-agent-conversation-append-only` and `save-each-chat-round-and-add-context-on-change`. Some deltas modify requirements in the text of those changes, thus those changes archive first.

Release. The user starts the harness release after the merge. The change does not change the version in `package.json`.
