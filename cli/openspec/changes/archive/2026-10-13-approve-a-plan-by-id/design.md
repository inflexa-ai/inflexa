# Design

## Context

- `runRoutes` holds `GET /plans/:planId` (`src/server/routes/runs.ts:228-251`). `RunRoutesOpts` (`:97-140`) holds each harness call, thus the route tests replace each call with a fake. A test runtime is a cast of `{ pool }` (`src/server/routes/runs.test.ts:56`).
- The cancel route builds a local session (`src/server/routes/runs.ts:298-303`). The chat turn builds its session with the local identity and `makeLocalAuth()` (`src/modules/harness/turn.ts:143-149`).
- `newTurnsRefused()` (`src/server/turns.ts:72-74`) is the stop flag, and the chat route answers 503 `draining` on it (`src/server/routes/conversation.ts:394-395`). `runningTurnsByThread()` (`src/server/turns.ts:117-124`) maps each thread with a running turn to that turn.
- `createSessionEmit` (`src/modules/harness/prov_bridge.ts:478-588`) stamps `systemActor()` and the model on each act, in an exhaustive switch. `currentUserActor()` (`src/modules/prov/prov.ts:35-38`) gives the person actor.
- The recorder strips the `prov.` prefix and applies the event through the kernel (`src/modules/prov/prov.ts:118-144`). `eventFields` of `src/lib/bus.ts` switches over each member with no default.
- `MessageBlock` switches over each part with a `never` default (`src/tui/layout/message_block.tsx:205-292`). `Part` takes each harness message part (`src/types/session.ts:136`).

## Goals / Non-Goals

**Goals:**

- One route that approves a plan with a fixed count of harness calls, and maps each refusal onto one status.

**Non-Goals:**

- No client fetcher and no TUI command. The consumer is the web client.
- No lock between an approval and a chat turn. The route refuses an approval while a turn runs on the thread, and the harness serializes the append.

## Decisions

### D1. The route

Add `POST /plans/:planId/approve` to `runRoutes`, behind the runtime gate. The route does these steps:

1. `newTurnsRefused()` gives 503 `draining`. The stop refuses new work before the body is read.
2. `readBody` with `z.object({ threadId: z.string().min(1) })`. A bad body gives 400 `validation_error`.
3. `runningTurnsByThread().has(threadId)` gives 409 `busy` with `details: { reasons: ["chat_turn"] }`, the details shape of the other busy refusals.
4. `opts.approvePlan(runtime, { analysisId, threadId, planId, identity: { user: "local" }, auth: makeLocalAuth() })`.
5. A success gives 201 with the result of the harness. When `started` is `true`, the route calls `noteAnalysisActivity(analysisId, Date.now())`.
6. A refusal maps through an exhaustive switch, with a `never` default:
   - `thread_not_found`: 404 `not_found`, "Thread not found."
   - `plan_not_found`: 404 `not_found`, "This analysis has no plan <planId>."
   - `superseded`: 409 `conflict`, `{ reason: "superseded", supersededBy }`
   - `plan_invalid`: 409 `conflict`, `{ reason: "plan_invalid", errors }`
   - `packages_missing`: 409 `conflict`, `{ reason: "packages_missing", missing, collisions, unavailable? }`
   - `not_authorized` and `suspended`: 409 `conflict`, `{ reason }`, with the reason of the authorizer in the message
   - `store_failed` and `launch_failed`: 500 through `internalError`

The body has a required field, thus `Bun.serve` applies no idle timeout of 10 s to the request, and the route needs no `holdConnection`.

### D2. The binding

`HarnessRuntime` gets `approvePlan: CoreRuntime["approvePlan"]`, set from `core.approvePlan` in `src/modules/harness/runtime.ts`. `RunRoutesOpts` gets `approvePlan: (runtime, input) => ResultAsync<PlanApproval, ApprovePlanRefusal>`, and the default calls `runtime.approvePlan(input)`. The tests give a fake, and they keep the cast runtime.

### D3. The wire types

`src/api/runs.ts` gets these types:

- `ApprovePlanBody`: `{ threadId: string }`
- `PlanApprovalResult`: `{ planId: string; runId: string; started: boolean; message: ChatMessage | null }`
- `PlanApprovalConflict`: the union of the conflict details of D1

`ChatMessage` comes as a type from `@inflexa-ai/harness/contracts/index.js`, thus a client loads no harness code.

### D4. The provenance member

- `src/types/prov.ts` re-exports `ProvPlanApprovalRef` from the kernel.
- `src/types/events.ts` gets `{ type: "prov.plan_approved"; analysisId; actor: ProvActor; approval: ProvPlanApprovalRef }`. It has no `model`, thus the stripped member equals the kernel member.
- `eventFields` of `src/lib/bus.ts` gives `threadId`, `planId`, and `runId`.
- `createSessionEmit` maps `approve-plan` onto the member with `currentUserActor()`, and `approvedAtMs: event.atMs`.

The recorder needs no change, because `toKernelEvent` maps each member by its name.

### D5. The TUI line

`MessageBlock` gets the case `data-plan-approval`. It renders `<MarkdownBody content={`Approved ${part.planId}.`} />`, the same body that a mention uses. The design gallery needs no new exhibit, because the line uses no new block.

## Risks / Trade-offs

- [A chat turn starts after the busy check and before the append] → The record lands between two rounds of the turn. The model view stays valid. The window is the time of the launch.
- [A web client approves a plan of a thread that a TUI shows] → The TUI shows the record after its next read of the thread.
