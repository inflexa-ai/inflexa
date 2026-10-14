# Proposal

## Why

GitHub issue #650: no host call approves a plan or starts its run. The agent asks for an approval in text, then calls `execute_analysis({ mode: "plan", planId })` (`src/prompts/conversation.ts:66-80`). Thus a model decides if a reply is an approval. A click on Approve costs one model turn, and the model can start a different plan. The plan launch is inside the `execute` body of the tool, and it reads the tool context (`src/tools/execute-analysis.ts:401-519`), thus a host cannot call it.

No provenance event records an approval (`src/provenance/seam.ts:111-155`).

The harness is the product core. Thus the approval comes first in the harness. The cli connects it in a companion change with the same name. The prov-kernel adds the core event in a third change with that name.

## What Changes

- An exported launch of a stored plan, `launchPlanRun`. It gives the run id and a flag that tells if the call started the run, or a typed refusal. It never throws. The plan mode of `execute_analysis` calls it, and the tool keeps its current failure protocol.
- An exported `approvePlan`. It refuses a thread that is not live in the analysis. It refuses an unknown plan, and a plan that a newer plan names as its parent. Then it launches the plan under a session. The host gives the identity and the auth of the session, and the harness gives its provenance. It appends one record to the thread that opens no model turn, and it emits one provenance event.
- The record: the model text "The person approved plan `<planId>`. Run `<runId>` started.", with no time in it. The display message holds a new part `data-plan-approval` `{ planId, runId, approvedAt }` and the `data-run-card` of the run.
- A new chat part `data-plan-approval`, in the contracts, the part schema, the part registry, and the stored display vocabulary.
- `conversationRecordTurn` takes optional display parts. With them, the display message of the record holds those parts in place of the text.
- A new session provenance event `approve-plan` `{ analysisId, threadId, planId, runId, atMs }`. `atMs` is the time of the approval, read before the launch.
- `CoreRuntime` gets `approvePlan`, bound over the deps that the conversation agent uses. The package root exports `launchPlanRun`, `approvePlan`, and their types.
- The conversation prompt gets one rule: an approval record means that the run of that plan started.

## Capabilities

### New Capabilities

- `plan-approval`: the launch of a stored plan, the approval of a plan by its id, the approval record, the new part, and the runtime binding.

### Modified Capabilities

- `provenance-seam`: the session emits an `approve-plan` event.
- `conversation-run-awareness`: the prompt teaches that an approval record means that the run of the plan started.

## Impact

- Harness code: `src/tools/execute-analysis.ts`, a new `src/app/approve-plan.ts`, `src/memory/thread-history.ts`, `src/memory/conversation-display-storage.ts`, `src/contracts/chat-parts.ts`, `src/contracts/schemas/chat-parts.ts`, `src/contracts/part-registry.ts`, `src/contracts/index.ts`, `src/provenance/seam.ts`, `src/runtime/assemble.ts`, `src/prompts/conversation.ts`, `src/index.ts`, and their tests.
- Database: no migration. The reads use the index of #649 on `cortex_plans(parent_plan_id)`.
- Embedders: `CoreRuntime` gets a new member, and `SessionProvenanceEvent` gets a new member. A host that switches over the session events exhaustively must add a case. The cli does this in its companion change.
