# Proposal

## Why

A chat turn runs in the memory of one request. When the host stops during a turn, the turn is lost: its model calls, its tool calls, and the reply that streamed so far. The loop of stage 1 makes each call a DBOS step, but only a workflow gets the checkpoints. This change runs each chat turn as a DBOS workflow, and each sub-agent as a child workflow. It is PR 2 of the three stacked PRs of #570.

## What Changes

- Each chat turn runs as a DBOS workflow. The workflow input holds the ids of the turn and no credential. The opening of the turn stays before the start, in the request of the host.
- The live credential of the request stays in the memory of the host. The harness reads it by the id of the turn. A recovered turn with no live credential ends as `failed` with the reason `interrupted`. Stage 3 changes this end to a pause.
- The turn writes its events to a durable stream of its workflow, in the harness frame format. The text deltas come from inside the model step. A host reads the stream from an offset, thus a client can connect again and get the rest of the turn.
- **BREAKING:** a host does not give an emit sink and an abort signal to a turn. It starts the turn, reads its stream, and stops it through the runtime.
- The writes of a turn are safe to run again: the rounds, the close, the compaction, the cut tool outputs, and the usage records. Each key comes from the id of the turn workflow.
- One turn runs on a thread at a time. A second turn on the same thread is refused before it opens.
- Each sub-agent (`literature_reviewer`, the planner of `generate_plan`, the reporter of `generate_analogy_report`) runs as a child workflow. Each of its calls is a checkpoint. Two sub-agents of one reply run at the same time.
- The synthesis of a run leaves its outer step, thus its reviewers can run as child workflows.
- An approval is decided before the tool runs. A tool declares an approval hook. The turn waits for the answer of the user with a durable wait. **BREAKING:** `ctx.ask` goes.
- `web_fetch` asks nothing. It refuses an internal address.
- Each tool call that writes is safe to run again: `update_working_memory`, `execute_analysis`, `start_report_session`, the authoring tools, `preview_report`, `record_report_version`, and the derivations.
- A derivation and an extraction run inside the step of their tool call, and they mint no mandate.
- A workflow takes its model configuration from its input (deferred from stage 1, decision D2 of `swap-agent-loop-for-ai-sdk`).

## Capabilities

### New Capabilities

- `chat-turn-stream`: the durable stream of a chat turn. The writer, the frame format, the read from an offset, and the merge of the streams of sub-agents.
- `sub-agent-workflows`: a sub-agent runs as a child workflow of the workflow of its caller.
- `tool-rerun-safety`: a tool call that runs again after a crash gives the same effect and the same result.

### Modified Capabilities

- `chat-turn`: the turn runs as a workflow. Its round writes, its close, and its compaction are safe to run again. One turn runs on a thread at a time. A recovered turn with no live credential ends as `interrupted`.
- `tool-approval`: the approval is decided before `execute` through a hook of the tool, and the wait is durable. `ctx.ask` goes.
- `chat-frame-translation`: the display projection of a round comes from the stream of the turn, thus a replayed round keeps its display parts.

## Impact

- Harness:
  - `app/chat-turn.ts`, and a new turn workflow with its stream
  - `loop/run-loop.ts`: the stream writer inside the model step, and the stable keys
  - `loop/tool-adapter.ts`: the sub-agent tools and the approval hook
  - the three sub-agent tools, and the synthesis in `workflows/execute-analysis.ts`
  - `tools/approval/`, `tools/research/web-fetch.ts`, and the report tools
  - `tasks/derive-table-exec.ts` and `tasks/extract-values.ts`, which go
  - `memory/thread-history.ts`, `memory/working-memory.ts`, and `execution/dbos-run-launcher.ts`
- Migrations: a key of each round on `messages`, a result table for the authoring calls, and the applied keys of the working memory.
- CLI: the conversation route reads the stream of the turn and serves it with an offset. The TUI connects again after a lost connection. `run_inflexa` and `manage_inputs` move to the approval hook.
- Cortex: a later PR in its own repository adapts its chat route.
