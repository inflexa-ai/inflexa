# Design

## Context

- A lifecycle action mints `inflexa:action-{mintActionId()}`, stamps start = end = the model clock, and associates the actor anonymously (`src/document.ts:285-297`).
- `appendRunStarted` writes the run activity `inflexa:run-{runId}` with the start time from the payload (`src/document.ts:453-468`).
- The session and report family adds its attributes in a second declaration of the action, because `appendLifecycleAction` owns the first one (`src/document.ts:735-747`).
- The cli recorder applies each event when the bus delivers it (`cli/src/modules/prov/prov.ts:124-144`). The harness emits `run_started` from the workflow body, and the approval from the route that starts that workflow. Thus the bus can deliver the two events in either order.

## Goals / Non-Goals

**Goals:**

- The approval names the person, the plan, the thread, and the run.
- The time of the approval is before the start time of its run, whatever the order of delivery.

**Non-Goals:**

- No plan entity. The kernel has no plan vocabulary, and the attributes carry the plan id.
- No version change of the package. The release controls the version.

## Decisions

### D1. A builder of its own, with the payload time

Add `appendPlanApproved(doc, analysisId, actor, approval)`. It reads the agent QName through `recordPreamble`, then declares the action activity one time, with start = end = the ISO of `approvedAtMs` and the three attributes. Then it appends the anonymous actor association and the `wasInformedBy` edge.

`appendLifecycleAction` stamps the model clock, thus the builder does not use it. A second declaration with the payload time would put two different formal times on one activity, which is a merge hazard.

Alternative: the model clock. The recorder applies the approval when the bus delivers it, which can be after `run_started`. Then the document can place the approval after the start of its run.

### D2. The run is informed by the approval

`wasInformedBy(inflexa:run-{runId}, action, "inflexa:informed-approval-{runId}")`. The edge can arrive before the run activity exists in the document. PROV permits a reference to an element that the document declares later, and `unified()` merges the run records by QName. The explicit id lets a repeated delivery merge.

Alternative: `wasStartedBy(run, undefined, action)`. The lineage read model already reads `wasInformedBy` (`src/lineage.ts`), and it does not read `wasStartedBy`.

### D3. The ref type

`ProvPlanApprovalRef = { threadId: string; planId: string; runId: string; approvedAtMs: number }` in `src/types.ts`, exported from `src/index.ts`. The event is `{ type: "plan_approved"; analysisId; actor; approval: ProvPlanApprovalRef }`.

## Risks / Trade-offs

- [The approval time is a wall-clock read] → The host emits the approval one time from a live bus, the same as each lifecycle action. Invariant 3 is about a replayed execution record.
- [The golden fixture bytes change] → The change is on purpose. `SPEC.md` records the member in the same change.
