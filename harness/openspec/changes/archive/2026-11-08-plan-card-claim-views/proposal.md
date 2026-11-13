# Proposal

## Why

In the run of analysis GSE136961, the plan card of the cli showed the id, the name, and the agent of each step. The step dialog showed the question, the criteria, the constraints, and the caveats. The `data-plan` part carries the grounding of each step, but its type does not name it, and the part has no claim views. Thus a host cannot show the title, the strength, or the sources of a rule.

## What Changes

- The `data-plan` part gets the optional field `claims`: the view of each claim that a step cites, with the keys of the part schema.
- The type of a plan step of the part names its `grounding`.
- The plan card builder copies the views of the stored plan.
- The planner sub-agent gives the full views of an accepted plan beside its output. The live card carries them, and the tool removes them before the model gets the result.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `plan-reads`: the `data-plan` card carries the claim views of the plan.
- `planning-enhancements`: the live card of `generate_plan` carries the claim views, and the result of the model does not.

## Impact

- `src/contracts/chat-parts.ts`, `src/contracts/schemas/chat-parts.ts`, `src/memory/card-builders.ts`, and `src/tools/research/generate-plan.ts` change.
- The result of the planner sub-agent gets one optional field. A result that an older version checkpointed has no field, and its card has no `claims`.
- The cli reads the new field in its plan card and its step dialog.
