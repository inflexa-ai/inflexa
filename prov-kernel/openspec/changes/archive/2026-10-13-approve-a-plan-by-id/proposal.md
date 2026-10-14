# Proposal

## Why

GitHub issue #650: a person approves a plan by its id, and the approval starts the run of the plan. The provenance export must show the approval before `run_started`, with the person as the agent. The core union has no approval member (`src/events.ts:30-79`). The cli records each `prov.*` member only through `applyProvEvent`, and a member with no kernel counterpart fails its build.

The harness and the cli add the approval in companion changes with the same name. This change adds the core event that the cli recorder maps.

## What Changes

- A new core member `plan_approved`, with the payload `approval: { threadId, planId, runId, approvedAtMs }`.
- Its mapping: one `inflexa:ApprovePlan` action activity at the time of the approval, associated with the actor, and a `wasInformedBy` edge from the run activity to the approval.
- The new ref type `ProvPlanApprovalRef`, exported from the package root.
- `SPEC.md` states the member, and the golden fixture covers it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `prov-kernel`: the core union carries the plan approval.

## Impact

- Kernel code: `src/events.ts`, `src/document.ts`, `src/types.ts`, `src/index.ts`, `SPEC.md`, the golden fixture, and the tests.
- Consumers: a host that switches over `ProvEvent` exhaustively must add a case. The cli maps the member in its companion change.
