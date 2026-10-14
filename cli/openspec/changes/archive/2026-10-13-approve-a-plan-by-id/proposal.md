# Proposal

## Why

GitHub issue #650: no route of the local server approves a plan or starts a run. The Approve button of the plan card (inflexa-ai/himmel#72) needs a route that starts the run with no model call, and records "Approved pln-…" in the chat.

The harness change `approve-a-plan-by-id` gives `approvePlan` on the runtime, the `data-plan-approval` part, and the `approve-plan` session event. The prov-kernel change with the same name gives the core event `plan_approved`. This change connects them to the local server, the bus, the recorder, and the TUI.

## What Changes

- `POST {A}/plans/:planId/approve`, with the body `{ threadId }`. The route calls the approval of the harness runtime under the local identity and the local auth.
- 201 gives `{ planId, runId, started, message }`. 409 `busy` while a chat turn runs on the thread. 409 `conflict` gives `details.reason`, and `details.supersededBy` for a replaced plan. 404 for an unknown plan or thread. 503 `draining` during a stop.
- `HarnessRuntime` gets `approvePlan` from the core runtime.
- The session emit of the bridge maps `approve-plan` onto the new bus member `prov.plan_approved`, with the person actor and no model. The recorder maps it through the kernel.
- The message block of the TUI renders the `data-plan-approval` part as the line `Approved <planId>.`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the runs group gets the approval of a plan, and a requirement states the approve route.
- `prov-harness-bridge`: the session emit maps the approval with the person actor.
- `prov-run-events`: the bus contract carries `prov.plan_approved`, and the recorder maps it through the kernel.
- `tui-stream-blocks`: the message block renders the approval part.

## Impact

- cli code: `src/api/runs.ts`, `src/server/routes/runs.ts`, `src/modules/harness/runtime.ts`, `src/modules/harness/prov_bridge.ts`, `src/types/events.ts`, `src/types/prov.ts`, `src/lib/bus.ts`, `src/tui/layout/message_block.tsx`, and their tests.
- The harness and the kernel: the route uses the harness change, and the recorder uses the kernel change. Thus `bun run harness:local` and `bun run kernel:local` come before the typecheck and the tests.
- No client fetcher. The consumer is the web client.
