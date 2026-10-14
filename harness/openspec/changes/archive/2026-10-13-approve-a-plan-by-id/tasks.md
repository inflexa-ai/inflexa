# Tasks

## 1. The part and the record

- [x] 1.1 Add `PlanApprovalPart`, `PlanApprovalPartSchema`, its `ChatPartSchema` member, its `PART_REGISTRY` entry, its `plan-approval` key in `ConversationUIData` and `dataSchemas`, and its exports from `src/contracts/index.ts` (design D7). Make sure that a test in `src/contracts` accepts a valid part and refuses a plan id off the `pln-<8hex>` shape. Make sure that a test in `src/memory/conversation-display-storage.test.ts` round-trips a stored part field for field.
- [x] 1.2 Give `conversationRecordTurn` optional display parts (design D4). Make sure that a test shows a record with parts: the display message holds the parts and no text part, and the model message is the synthetic record of the text. Make sure that a record with no parts keeps its text part.

## 2. The launch

- [x] 2.1 Add `launchPlanRun`, `PlanLaunch`, `LaunchPlanRunRefusal`, and `LaunchPlanRunDeps`, and move the common launch tail into one internal function that gives a `Result` (design D1). Make sure that tests in `src/tools/execute-analysis.test.ts` cover each scenario of "The harness launches a stored plan through one function", and the `suspended` refusal, the dedup collision, and a failed start. A test must show that the function gives a refusal and no rejected promise for each case.
- [x] 2.2 Move the plan mode of `execute_analysis` onto `launchPlanRun`, and the ad hoc arm onto the shared tail (design D1). Make sure that each existing test of `src/tools/execute-analysis.test.ts` passes with no change of its assertions, and that a test covers each scenario of "The plan mode of execute_analysis keeps its failure protocol".

## 3. The approval

- [x] 3.1 Add `approve-plan` to `SessionProvenanceEvent` in `src/provenance/seam.ts`, with `analysisId`, `threadId`, `planId`, `runId`, and `atMs` (spec `provenance-seam`). Make sure that the harness typecheck passes.
- [x] 3.2 Add `src/app/approve-plan.ts` with `approvePlan`, `ApprovePlanInput`, `PlanApproval`, and `ApprovePlanRefusal` (design D2, D3, D5, D6). Make sure that a `withSchema` test covers each scenario of "The harness approves a plan by its id" and of "The approval record tells the model that the run started". The test uses a fake run launcher and a fake run authorizer, and it reads the thread with `createThreadHistory`. A test must show that `atMs` is not later than the call of the launcher. A test must show that a failed append gives `message: null` with the run started.

## 4. The runtime, the exports, and the prompt

- [x] 4.1 Add `approvePlan` to `CoreRuntime`, and bind it in `assembleCoreRuntime` (design D8). Make sure that a test of `src/runtime/assemble.test.ts` shows that the bound function reaches the run launcher of the conversation deps.
- [x] 4.2 Export the names of design D8 from `src/index.ts`. Make sure that a barrel test imports `launchPlanRun` and `approvePlan` and the types from `@inflexa-ai/harness`.
- [x] 4.3 Add the approval rule to step 5 of "Analysis Planning" in `src/prompts/conversation.ts` (design D9). Make sure that a test of `src/agents/conversation-agent.test.ts` finds the rule in the system prompt.

## 5. Verification

- [x] 5.1 Run `bun run format:file` on the changed files. Then run `bun run typecheck`, `bun run lint`, `bun run build`, and `bun run test:full src/tools src/app src/memory src/contracts src/provenance src/runtime src/agents src/state`. Make sure that each command passes.
