# Proposal

## Why

In the run of analysis GSE136961, the three step summaries held no rule id and no DOI. The T1S3 agent read a decision record with 18 claim titles and 7 citations, and its summary cited none of them. The run panel showed the template id and nothing more. The decision records and the claim views of the plan hold these facts as data. Thus the host can write them, and the agent does not have to.

## What Changes

- Each child input carries the grounding of its plan step and the claim views of its claims.
- After the summarizer, the host reads the decision records of the step. Each read is confined to the step directory and bounded in size and in count.
- The host builds the methods of the step: the grounding, the templates with their methods, the rules with their titles, the sources, and the license.
- The host appends a "Methods and sources" block to the summary markdown. The block stands alone when the summary of the agent fails.
- `StepSummary` gets the optional `methods` field.
- Each step with methods emits one new `data-step-methods` part beside its summary.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `step-interpretation-summary`: the host writes the methods and sources of a step, and the summary carries them.

## Impact

- `src/execution/step-methods.ts` is new. `src/execution/post-step-pipeline.ts`, `src/workflows/sandbox-step.ts`, `src/workflows/execute-analysis.ts`, and `src/schemas/step-summary.ts` change.
- The contracts get the `data-step-methods` part. The cli adds the part to its list of sidebar parts in `cli/src/tui/layout/message_block.tsx`.
- The block runs inside the checkpointed step of the summary. Thus the workflow body keeps its sequence of steps, and it needs no `DBOS.patch`.
- A child input or a summary checkpoint written before the change has no methods.
