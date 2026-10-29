# Carry the request of a plan to each step

## Why

A step agent sees its plan step and never the conversation. When a request names the exact format of a deliverable (the file name, the fields, the allowed values, the shape of an entry), the plan often names only the file and its keys. In bench rollouts the step that wrote `answer.json` then invented a verdict and the fields of each claim, and the answer did not parse. A sentence in the planner prompt that asked to copy the format did not fix it.

## What Changes

- The stored plan carries `request`: the `researchQuestion` that `generate_plan` received. The planner does not write the field, the persist step sets it.
- `researchQuestion` asks for the words of the user, with each deliverable and its format.
- The run input snapshots `request`, and the seed of each step renders it as `## The request of the analysis`, bounded to 8000 characters.
- An ad hoc plan carries no `request`: its one step already has the request as its task.

## Impact

- `harness/src/schemas/workflow-state.ts`, `harness/src/schemas/plan-schemas.ts`, `harness/src/tools/research/generate-plan.ts`, `harness/src/tools/execute-analysis.ts`, `harness/src/workflows/execute-analysis.ts`, `harness/src/prompts/briefing.ts`, and their tests.
- A run that started before the change has no `request` in its input, and its seeds stay as they were.
