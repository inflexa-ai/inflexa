# Proposal

## Why

In the run of analysis GSE136961, the step agents got the claim ids of the plan, and no rule text. Thus no step summary named a rule or a source. A setting that no slot carries lost its source in the briefing.

The briefing also dropped the notes of the template contract. One note tells the agent that the script renames the condition column to `condition`. Without it, the agent sent a design formula that ends with the column name of the plan. The tool refused the formula with the regular expression of the slot only, and the agent needed one more turn to find the fix.

## What Changes

- The run input carries the claim views that the plan keeps. The Grounding section of the briefing renders each claim with its strength and its title. A claim with no view renders as its id. A plan with no view keeps the one line of ids.
- A view reaches a step only when its claim id and its snapshot digest match the grounding of the step.
- Each line under `Unbound settings` gives the source of the setting beside its procedure step.
- The `Template contract` section renders the notes of the contract, clamped to `TEMPLATE_NOTES_MAX_CHARS`.
- A refusal of a local slot value gives the description of the slot after the reason.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `knowledge-plane-tools`: the briefing names each cited claim by its title, and it carries the notes of the template and the source of each unbound setting. A local refusal gives the description of the slot.

## Impact

- `src/prompts/briefing.ts`, `src/workflows/execute-analysis.ts`, `src/tools/execute-analysis.ts`, and `src/tools/knowledge/template.ts` change.
- `ExecuteAnalysisInput` gets the optional `claims` field. A run that started before the field existed renders the claim ids only.
- `src/tools/knowledge/local-slots.ts` does not change, because it is a copy of the renderer of the service.
