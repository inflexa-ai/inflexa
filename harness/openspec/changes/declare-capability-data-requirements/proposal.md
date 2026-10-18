# Declare the data requirement of a capability

## Why

A capability cannot run without its reference data. Today only the skill of the agent names that data, and only a sandbox step agent reads a skill. Thus no surface above the step can name the datasets that a request needs.

The matched negative gene set shows the cost. A request for it on a default store produced a method design in the chat, and the six datasets of the method were never named. The chat agent holds the tool that installs a dataset, and its prompt tells it to offer that route before it calls a gap permanent. But nothing told it which datasets to name.

A plan step already declares its packages. A pre-launch pass then refuses a plan whose packages cannot link, and the refusal names each absent package. Reference data has no declaration and no such pass. Thus an absent dataset costs a full run to find.

## What Changes

- `AgentMeta` gains the data requirement of each capability: the catalog dataset ids that the capability cannot run without.
- A plan step gains a `capability` field. It carries the capability phrase of the agent that the step was assigned for.
- A pre-launch pass resolves the requirement of that capability against the reference store. An absent dataset refuses the launch with the reason `references_missing`, which names each id.
- One harness tool answers the data requirement of a capability against the live store. Thus a surface that reads no skill can name each absent dataset before it plans.
- The cli maps the new refusal onto its conflict shape, as it maps `packages_missing` today.

The first consumer is the `translational-safety-agent` capability for a matched negative gene set. Its six datasets become a declaration.

## Capabilities

### New Capabilities

- `capability-data-requirements`: the declaration on the agent metadata, the step field, and the pre-launch resolution against the store. It also covers the refusal that names each absent dataset, and the tool that answers a requirement.

### Modified Capabilities

- `agent-roster`: `AgentMeta` carries the data requirement of a capability. The rendered catalog keeps the dataset ids out, thus no prompt names a dataset.
- `plan-approval`: the launch refuses a plan whose declared reference data is absent from the store, and the refusal names each dataset.

## Impact

- `harness/src/agents/sandbox/types.ts`, `harness/src/agents/sandbox-catalog.ts`, and each agent file that declares a requirement.
- `harness/src/schemas/workflow-state.ts`: the `capability` field of a step.
- `harness/src/tools/execute-analysis.ts`: the pre-launch pass and the new error.
- `harness/src/prompts/planner.ts`: the step field, and the rule that fills it with a phrase of the catalog.
- `cli/src/api/runs.ts` and `cli/src/server/routes/runs.ts`: the refusal shape of the conflict.
- No change to the catalog, to the receipt logic, or to an installed store. A plan with no `capability` field behaves as it does today. No prompt names a dataset, because the ids stay in the metadata and in the tool.
