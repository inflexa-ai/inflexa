## Why

Every part between the block contract and a conversation is on main: the authoring tools, the snapshot, the renderer, the versions, and the spawn. But no agent serves a `report` thread, and `agents.forThread("report")` refuses with `unregistered_thread_type`. This change adds the agent, and it is the step that #225 tracks.

## What Changes

- Add the Report Builder agent definition, with an id that does not collide with the old templating agent. The old id `report-builder` stays live until #313.
- Register the agent under the `report` thread type in the assembly registry of `assembleCoreRuntime`. The reserved refusal slot becomes a real entry.
- Add the report-session runtime: a durable session-state row for each report thread, behind the singleton agent. The row holds the in-progress document and the pinned snapshot, keyed by the thread id.
- The snapshot mints one time for each thread, at the first use, and the row keeps it. Thus the state survives a restart and a replica change, and the frozen anchor holds.
- Change the authoring tool factory of #305 to a storage-backed gateway. It has no callers, thus the signature changes freely, and the tool ids and the envelopes stay.
- Add the render-and-preview tool. It bridges each resolved value into the `RenderValues` of the renderer, and it reaches the page through the `PreviewPublisher` seam. An absent resolver realization or an unavailable publisher gives a typed degrade, not an error.
- Add the prompt module of the agent, with the conversational composition, because the agent talks to the user.
- The roster is read-only toward the analysis: the workspace read surface, the workspace search, `inspect_run`, and `inspect_data_profile`. No tool starts a run, and no tool changes the analysis. The rule holds by construction.

## Capabilities

### New Capabilities

- `report-session-agent`: the agent definition, the thread-keyed session runtime, the roster rule, the render-and-preview tool, and the prompt obligations.

### Modified Capabilities

- `thread-agent-resolution`: the `report` type resolves to the Report Builder agent, and it does not refuse any more.
- `report-authoring`: the tool surface binds to a session-state gateway in place of the closure holder, and a landed operation persists before it reports.

## Impact

- New code under `harness/src/agents/`, `harness/src/app/` for the session runtime, `harness/src/state/` for the session-state store, `harness/src/tools/report-session/` for the preview tool, and `harness/src/prompts/`.
- One edit in `src/runtime/assemble.ts`: the registry entry for `report`. One DDL addition in `src/state/init.ts` for the session-state table.
- A signature change in `src/tools/report-authoring/authoring-tools.ts`, which has no callers.
- The work is dormant in production: no path spawns or serves a `report` thread until #314. The old report path stays live and untouched.
- Out of scope: the gate (#310), a skill pack (#311), the parent-transcript tool, and any context composition (#223).
- No new dependency.
