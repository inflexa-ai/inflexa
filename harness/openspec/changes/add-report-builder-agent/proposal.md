## Why

Every part between the block contract and a conversation is on main: the authoring tools, the snapshot, the renderer, the versions, and the spawn. But no agent serves a `report` thread, and `agents.forThread("report")` refuses with `unregistered_thread_type`. This change adds the agent, and it is the step that #225 tracks.

## What Changes

- Add the Report Builder agent definition, with an id that does not collide with the old templating agent. The old id `report-builder` stays live until #313.
- Register the agent under the `report` thread type in the assembly registry of `assembleCoreRuntime`. The reserved refusal slot becomes a real entry.
- Add the report-session runtime: a thread-keyed binder that holds the per-session state behind the singleton agent. The state is the pinned snapshot and the draft of the authoring tools, keyed by `scope.threadId`.
- The snapshot mints one time for each thread, at the first use. A restart loses an in-progress draft, and the recorded version stays the durable artifact.
- Add the render-and-preview tool. It bridges each resolved value into the `RenderValues` of the renderer, and it reaches the page through the `PreviewPublisher` seam. An absent resolver realization or an unavailable publisher gives a typed degrade, not an error.
- Add the prompt module of the agent, with the conversational composition, because the agent talks to the user.
- The roster is read-only toward the analysis: the workspace read surface, the workspace search, `inspect_run`, and `inspect_data_profile`. No tool starts a run, and no tool changes the analysis. The rule holds by construction.

## Capabilities

### New Capabilities

- `report-session-agent`: the agent definition, the thread-keyed session runtime, the roster rule, the render-and-preview tool, and the prompt obligations.

### Modified Capabilities

- `thread-agent-resolution`: the `report` type resolves to the Report Builder agent, and it does not refuse any more.

## Impact

- New code under `harness/src/agents/`, `harness/src/app/` for the session runtime, `harness/src/tools/report-session/` for the preview tool, and `harness/src/prompts/`.
- One edit in `src/runtime/assemble.ts`: the registry entry for `report`.
- The work is dormant in production: no path spawns or serves a `report` thread until #314. The old report path stays live and untouched.
- Out of scope: the gate (#310), a durable draft store, a skill pack (#311), the parent-transcript tool, and any context composition (#223).
- No new dependency.
