# Design

## Context

- The plan launch is inside the `execute` body of `execute_analysis` (`src/tools/execute-analysis.ts:401-519`). It reads `ctx.session` (`:402-405`), and it emits the run card through `ctx.emit` (`:407-410`). The plan mode and the ad hoc mode share the second half: the package link pass (`:428`), the run reservation (`:430-466`), the authorization (`:468-495`), and the workflow start (`:497-514`).
- The plan mode throws `PlanNotFoundError` (`:415`), `PlanMalformedError` (`:252`), `PlanValidationError` (`:254`), `PlanPackagesMissingError` (`:172`, `:180`, `:207`), and each store failure through `unwrapOrThrow`. It gives an error result for an authorization refusal (`:477-494`). The tool tests pin these classes.
- `insertRun` rejects its promise with `RunDedupCollisionError` on a collision of the active-plan index (`src/state/runs.ts:64-103`). It does not give an `err`.
- The harness throws only at a DBOS boundary or in a tool body. It catches only at a DBOS, an API, a client, or the dispatch boundary. Refer to the spec `harness-durable-runtime`, "The harness throws only at a DBOS boundary or at the tool dispatch". An exported function that a host route calls is an API boundary. Thus it gives a `Result`, and it never throws.
- `conversationRecordTurn(text)` (`src/memory/thread-history.ts:138-143`) builds a host record: a synthetic record message, and a display message of the role `system` with one text part. `appendTurn` gives no seq and no row time (`:503-511`).
- The harness never mints an `auth` capability (`CLAUDE.md`, "Session model"). The host gives it, as the chat turn session does (`cli/src/modules/harness/turn.ts:143-149`).
- `bindSessionEmit` (`src/provenance/seam.ts:196-213`) gives a total, guarded emit. The session events carry no time today (`:111-155`). The run events carry `atMs` from `DBOS.now()` (`:52-77`).
- `run_started` is emitted inside the workflow body, after the `seed-step-executions` step (`src/workflows/execute-analysis.ts:831-857`). `DBOS.startWorkflow` does not wait for the body (`src/execution/dbos-run-launcher.ts:37`).

## Goals / Non-Goals

**Goals:**

- One launch code path for the tool and for the approval.
- A launch and an approval that give a `Result` to a host, with each refusal typed.
- An approval record and an approval event that tell the truth about the run.

**Non-Goals:**

- No change of the ad hoc behavior of `execute_analysis`.
- No lock that serializes an approval with a chat turn. The cli refuses an approval while a turn runs on the thread.
- No HTTP route. The cli companion change adds it.
- No change of the plan writes or of the plan reads of #649.

## Decisions

### D1. `launchPlanRun` and one shared launch tail

Add `launchPlanRun(deps, { session, planId })` to `src/tools/execute-analysis.ts`. It gives `ResultAsync<PlanLaunch, LaunchPlanRunRefusal>`:

```ts
type PlanLaunch = { runId: string; started: boolean };
type LaunchPlanRunRefusal =
    | { type: "plan_not_found"; planId: string }
    | { type: "plan_invalid"; planId: string; malformed: boolean; errors: string[] }
    | { type: "packages_missing"; missing: string[]; collisions: string[]; unavailable?: string }
    | { type: "not_authorized"; reason: string }
    | { type: "suspended"; reason: string }
    | { type: "store_failed"; cause: unknown }
    | { type: "launch_failed"; cause: unknown };
```

`deps` is `LaunchPlanRunDeps`: `pool`, `executeAnalysisWorkflow`, `runAuthorizer`, `runLauncher`, `resourcePolicy`, `extendAnalysisFarm`, and `logger` of `ExecuteAnalysisToolDeps`. `session` is an `AgentSession` with an analysis scope.

The common half moves into one internal function that gives a `Result`: the link pass, the reservation, the authorization, and the start. The plan mode of `launchPlanRun` and the ad hoc arm of the tool both call it. The reservation stays per mode: `insertRun` with the dedup recovery for a plan, and `reserveRunById` for an ad hoc run. The synthesis flag stays per mode.

The current throw sites become refusals:

- `linkPlanPackages` gives a `Result` with `packages_missing`.
- The parse disagreement of the link pass (`:159`) and a step with no resources (`:238`) cannot occur after `validatePlan`. Each gives `plan_invalid` with its message.
- The dedup rejection of `insertRun` is caught at this API boundary, and the function reads the active run. No active run gives `store_failed` with the collision error as its cause.
- A throw of `runLauncher.launch` is caught at this client boundary. The function revokes the authorization, marks the run `failed`, and gives `launch_failed` with the cause.

The tool maps each refusal back to its current outcome. `plan_not_found`, `plan_invalid`, and `packages_missing` throw the current error classes with the current messages. `store_failed` goes through `unwrapOrThrow(err(cause))`. It throws an `Error` cause with its class, thus the collision error stays as before, and it wraps a `DbError` as before. `launch_failed` throws its cause. `not_authorized` and `suspended` give the current error results. On a success, the tool emits the run card and gives `{ runId, status: "in_progress" }`, for `started` true and false alike.

Alternative: export the current tool body with a fake tool context. That keeps the throws, and a route then has to catch them, which the error rules forbid.

### D2. `approvePlan` in `src/app/approve-plan.ts`

`approvePlan(deps, input)` gives `ResultAsync<PlanApproval, ApprovePlanRefusal>`:

```ts
type ApprovePlanInput = { analysisId: string; threadId: string; planId: string; identity: Identity; auth: AuthContext };
type PlanApproval = { planId: string; runId: string; started: boolean; message: ChatMessage | null };
type ApprovePlanRefusal = LaunchPlanRunRefusal | { type: "thread_not_found" } | { type: "superseded"; supersededBy: string };
```

`deps` is `LaunchPlanRunDeps` and an optional `provenance` member. The function builds its thread store and its thread history over `deps.pool`. It does these steps:

1. Read the thread (`createThreadStore(pool).getThread`) and the plan record (`loadPlanRecord`) at the same time. A thread that is `null`, or of a different analysis, gives `thread_not_found`. The store read sees a live thread only. A `null` record gives `plan_not_found`. A record with `supersededBy` gives `superseded`.
2. Read `approvedAtMs = Date.now()`.
3. Build the session: the identity and the auth of the input, the scope `{ kind: "analysis", analysisId, threadId }`, and the provenance `{ agentId: "plan-approval", callPath: ["plan-approval"] }`.
4. Call `launchPlanRun`. A refusal passes through.
5. When `started` is `false`, give `{ planId, runId, started: false, message: null }`.
6. Emit `approve-plan` through `bindSessionEmit(deps.provenance, logger)`.
7. Read the run card with `buildRunCardData(pool, { planId, analysisId, runId })`. The launch validated the plan, thus only a failed read gives no card. The function logs that failure.
8. Build the record with `conversationRecordTurn(text, parts)`, and append it with `appendTurn`. A failed append logs an error with the ids, and `message` is `null`.
9. Give `{ planId, runId, started: true, message }`. `message` is the display message of the record through `conversationUIToChatMessages`.

The host gives the identity and the auth, because the harness forwards the auth and never mints it. The harness gives the provenance, as it does for a chat turn. Thus the run of an approval carries `plan-approval` in its call path, and a run of the tool carries `conversation-agent`.

Alternative: take a whole `RequestSession`. Then each host restates the provenance, and two hosts can disagree on it.

### D3. The time of the approval orders it before the start of the run

The event carries `atMs`, read before the launch. The kernel writes the approval action at that time (cli and prov-kernel companion changes). The run start is a `DBOS.now()` read inside the workflow body, after the launch. Thus the document places the approval before `run_started`, whatever order the bus delivers the two events in.

Alternative: emit before the launch. A failed start then leaves an approval of a run that never ran. Also, the rule of `ProvenanceSeam` says that a site emits after its act lands. Alternative: let the recorder use its own clock. The workflow body can emit `run_started` before the route emits the approval, thus the order is not guaranteed.

### D4. A record with display parts

`conversationRecordTurn(text, displayParts?)` takes optional non-text message parts. With a non-empty list, the display message holds those parts, each through `conversationDisplayPart`, and no text part. With no list, it keeps the text part. The model message is the synthetic record message of `text` in both cases. The record text names no time, because the model view must not change with the clock.

The approval record text is `The person approved plan ${planId}. Run ${runId} started.`. Its display parts are the `data-plan-approval` part and, when the read gives one, the `data-run-card` part.

The result gives the display message with no `createdAt`. The transcript read adds the row time to it.

Alternative: read the thread back after the append. That read reads each row of the thread, thus its cost grows with the thread. Alternative: give the row time from `appendTurn`. That changes the public `ThreadHistory` interface for one caller.

### D5. No record and no event for an active plan

`started: false` means that the plan already has an active run. The approval then changes nothing. A second record would tell the model that a run started again. A second action would put two approvals of one run in the document. Thus the function appends nothing and emits nothing, and `message` is `null`.

### D6. A failed record does not fail the approval

The run started when the append runs. A failed approval would make a client try again, and the second try would give `started: false`. Thus the function logs the failure and gives the run with `message: null`.

### D7. The part `data-plan-approval`

- `PlanApprovalPart` in `src/contracts/chat-parts.ts`: `{ type: "data-plan-approval"; planId: string; runId: string; approvedAt: string }`, in the `ChatPart` union. It has no `id`, because no reader reconciles it.
- `PlanApprovalPartSchema` in `src/contracts/schemas/chat-parts.ts`, with `planId` on the `pln-<8hex>` shape, `approvedAt` as an ISO 8601 date and time, and its member in `ChatPartSchema`. `approvedAt` is `new Date(atMs).toISOString()`.
- `PART_REGISTRY` entry: emitter `conversation`, consumer `conversation`, not transient, not reconciling.
- `ConversationUIData` and `dataSchemas` of `src/memory/conversation-display-storage.ts` get the key `plan-approval`.
- `src/contracts/index.ts` exports the type and the schema.

### D8. The runtime binding and the exports

`CoreRuntime` gets `approvePlan: (input: ApprovePlanInput) => ResultAsync<PlanApproval, ApprovePlanRefusal>`. `assembleCoreRuntime` binds it over `conversation.pool`, the registered `executeAnalysis`, `conversation.runAuthorizer`, `conversation.runLauncher`, `resourcePolicy`, `conversation.extendAnalysisFarm`, `conversation.logger`, and `deps.provenance`. These are the values that reach the tool, thus the approval gets the pool-miss remedy of the host too.

`src/index.ts` exports `launchPlanRun`, `approvePlan`, `PlanLaunch`, `LaunchPlanRunRefusal`, `LaunchPlanRunDeps`, `ApprovePlanInput`, `PlanApproval`, `ApprovePlanRefusal`, and `PlanApprovalPart`. A barrel test imports them from the root.

### D9. The prompt rule

Step 5 of "Analysis Planning" in `src/prompts/conversation.ts` gets one sentence: a record that says that the person approved a plan means that the run of that plan started. The prompt stays a constant.

## Risks / Trade-offs

- [A chat turn opens on the thread after the busy check of the cli] → The record lands between two rounds of that turn. The record is a synthetic `user` row, thus the model view stays a valid sequence.
- [A retraction of the turn before the record removes the record, and the run continues] → This is the rule of each host record (spec `ai-sdk-message-storage`, "A host-authored synthetic message opens no turn").
- [A new plan names the plan as its parent after the check and before the launch] → The window is two reads long. The approval then starts the older plan.
- [The approval and the run start share one millisecond] → The workflow reads the run start after it seeds its steps, which is one database write. Thus an equal time is not a practical case.
- [The plan is read two times: the record read and the launch read] → Both reads use the primary key. The launch stays whole for the tool.
- [An embedder switches over the session events exhaustively] → The new member fails its build until it adds a case. The cli adds it in its companion change.

The reads of an approval are bounded:

- one thread read by the primary key
- one plan read with an indexed child subquery
- the launch reads: one plan read by the primary key and one active-run read on the partial unique index
- one plan read for the card
- the append under the lock of the thread

No read grows with the transcript or the run history.

## Migration Plan

No migration. The index on `cortex_plans(parent_plan_id)` of #649 serves `supersededBy`.
