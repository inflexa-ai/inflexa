# Proposal

## Why

A grounded step lists its settings and the claims that it cites. A setting does not say which rule gives its value. The `source` of a setting names a paper, a guide, or a vignette more often than a rule. Thus a reader of the plan cannot go from a setting to its rule, and the list of the rules of a step has no link to the settings.

A host cannot find the rule by a search. Two rules of a step can give the same value, and a rule can give a setting to a step that a different rule selects.

The knowledge service knows the rule, because it selects one rule for each parameter. The service now gives the claim id of that rule on each parameter of a procedure step.

## What Changes

- The client reads the optional `rule` of a parameter of a procedure step.
- A setting of a grounding carries the optional `rule`, the claim id of the rule that gives the value.
- The skeleton step copies the `rule` of each parameter to its setting. The host writes the settings of a skeleton step, thus the stored plan holds the `rule`.
- The `data-plan` part keeps the `rule` of a setting.
- A stored plan with no `rule` loads as before. The harness derives no `rule` for it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `knowledge-plane-tools`: a setting of a grounding names the rule that gives its value.

## Impact

- `src/tools/knowledge/client.ts`, `src/tools/knowledge/skeleton.ts`, `src/schemas/workflow-state.ts`, and `src/contracts/schemas/chat-parts.ts` change.
- A service that gives no `rule` gives the same plan as before.
- The binding of the template, the seed, and the decision record do not read the field.
