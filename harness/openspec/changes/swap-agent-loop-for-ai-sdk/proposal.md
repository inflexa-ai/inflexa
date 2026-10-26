# Proposal

## Why

The harness keeps its own agent loop (`loop/run-agent.ts`, 1,542 lines), its own durable-step wrapper, its own tool dispatch, and its own provider retry loop. The AI SDK v7 loop and `@dbos-inc/vercel-ai` do the same work: the library makes each model call and each tool call a DBOS step, and a sub-agent a child workflow. This change moves the harness onto the two libraries, thus the harness keeps only the work that the libraries do not do (issue #570).

This change is the first of three stacked PRs:

1. **This change: swap the loop.** The behavior stays the same. A chat turn still runs in process.
2. The chat turn becomes a durable DBOS workflow, and the sub-agents become child workflows.
3. A run and a chat turn can pause and resume.

## What Changes

- The loop runs on AI SDK `streamText` with `stopWhen`. Inside a DBOS workflow, the `durableCalls` middleware makes each model call a step, and `durableTools` makes each tool call a step. Outside a workflow, the calls run directly.
- **BREAKING** The hand-rolled loop, its step names (`llm-N`, `tool-<name>-<id>`, `llm:N`), the `RunStep` adapters, the step and inline execution modes, `continueAgent` step namespaces, and `runToTerminal` go. A workflow that is in flight at the switch cannot replay. The switch runs during downtime.
- The tool mask, the tool budget, and the call guard of the planner become one `toolApproval` policy that refuses a call. The declared tools never change.
- A submit tool no longer ends the run. The agent submits as often as it wants, and the last accepted submission is the outcome. `validate_synthesis` goes. Each agent selects its outcome from the typed tool results, not from a closure.
- The host fills each value that it knows, for example the `runId` of a synthesis, and the snapshot and the template of a plan. The model does not copy them.
- `edit_file` records its intent before it writes, and `write_file` and `edit_file` write through a temporary file and an atomic rename. A rerun of the step then gives the same result.
- The truncation recovery and the wrap-up at the iteration cap do not carry over. The bench runs show if either one is necessary.
- One classifier names each model failure that time or a person can repair: a provider outage, a billing refusal, or a missing credential. Each failure keeps the outcome that it has today. The third PR adds the pause.
- **BREAKING** `runAgent`, `RunStep`, `passthroughStep`, `durableStep`, `createStreamingChat`, and `AgentChat` leave the public surface. The chat turn makes the streaming chat, the usage recorder, and the approval binding itself. A host gives only its transport values.
- The DBOS SDK moves to version 5.1 or later. `@dbos-inc/vercel-ai` joins the dependencies at an exact version.

## Capabilities

### New Capabilities

- `harness-agent-loop`: the agent loop on the AI SDK and `@dbos-inc/vercel-ai`, stated as behavior only. The old capability of this name is removed from the main specs. Thus this change adds it again with new content.
- `analogy-report`: the outcome of the analogical reasoner. The old capability is removed from the main specs, and this change adds it again with the new outcome rule.

### Modified Capabilities

Each modified capability gets ADDED requirements only. The old requirements that this change replaces are already removed from the main specs.

- `planning-enhancements`: the planner submits through tools that do not end the run, and one salvage request follows a run with no outcome.
- `planner-call-guard`: the guard is an approval policy over the search tools.
- `literature-reviewer`: the synthesizer submits through a tool that does not end the run, and the host stamps the `runId`.
- `data-profile-init`: the profiler submits until it is satisfied, and the workflow applies the final sweep to the last submission.
- `report-authoring`: the report agent runs one tool call at a time.
- `chat-turn`: a host gives only its transport values.
- `harness-embedder-exports`: the loop internals leave the root barrel.

## Impact

- **Code:** `harness/src/loop/` (most of it goes), `harness/src/providers/` (the chat wrapper and its retry loop), `harness/src/tools/define-tool.ts`, `harness/src/app/chat-turn.ts`, the terminal tools of the planner, the synthesizer, the analogy reasoner, and the data profiler, `harness/src/tools/workspace/edit-file.ts` and `mutator.ts`, and `harness/src/index.ts`.
- **Embedders:** the CLI adapts in this PR. Cortex adapts in a follow-up PR in its own repository.
- **Dependencies:** `@dbos-inc/dbos-sdk` 5.1 or later, `@dbos-inc/vercel-ai` at an exact version, `ai` 7.
- **Out of scope:** the sandbox internals (a separate plan exists), the durable chat turn, `agentTool` sub-agents, the move of `ctx.ask` to `toolApproval`, and pause and resume.
