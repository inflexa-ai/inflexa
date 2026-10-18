## Context

The change `add-matched-negative-gene-set` gave the harness a method that six opt-in datasets feed. A test run on 2026-10-18 showed the gap. The chat agent surveyed the store, found no ortholog table, and designed its own method. It then offered a substitute for the absent data, which the method forbids.

The current state:

- A skill names the datasets of a method by what each one is. Only a sandbox step agent reads a skill (`src/tools/sandbox/skills.ts`).
- The prompt of the conversation agent carries no agent catalog and no skill. It forbids a report of an environment gap as permanent, and it tells the agent to offer a provisioning route (`src/prompts/conversation.ts:374`).
- The cli gives that agent the tool that drives its own command surface (`cli/src/modules/harness/runtime.ts:1186`). The `refs download` command is approval-gated (`cli/src/cli/index.ts:917`), thus the user confirms each fetch.
- A plan step declares its packages (`src/schemas/workflow-state.ts:88`). The pre-launch link pass refuses a plan whose packages cannot link, with `PlanPackagesMissingError` naming each absent package (`src/tools/execute-analysis.ts:111`). The remedy belongs to the embedder.
- A capability phrase names the data classes of a capability. The planner reads it from the rendered catalog (`src/agents/sandbox-catalog.ts:54`).

The constraints come from the root `CLAUDE.md`, "Agent-facing content". A prompt names a tool and never a dataset. A skill names a dataset and never a path. A tool describes itself at attach time.

## Goals / Non-Goals

**Goals:**

- A capability states which datasets it cannot run without, in one typed place.
- A surface that reads no skill can name each absent dataset of a request.
- A launch stops before the run when a declared dataset is absent, and the refusal names each id.
- The declaration is checked, not prose. A wrong id fails a test, not an analysis.

**Non-Goals:**

- No change to the catalog, to a receipt, or to an installed store.
- No automatic download. An install stays an approved action of the user.
- No new dataset becomes recommended. Each one stays opt-in.
- No dataset id in a prompt.
- No change to the package declaration or to its link pass.

## Decisions

### The requirement belongs to the capability, not to the agent and not to the skill

An agent holds many capabilities. The `translational-safety-agent` assesses a CYP liability and it builds a matched negative set. The first needs no phenotype release. Thus a requirement on the agent would refuse a run that needs nothing.

A requirement on the skill cannot reach a surface above the step, because only a step agent reads a skill. The skill keeps its own account of the data, in the words of the method. The two are not a duplicate: the skill says what the data is and how to use it, and the declaration says which catalog entry carries it.

`AgentMeta` gains one optional field:

```ts
readonly dataRequirements?: readonly {
    /** One phrase of this agent's own `capabilities`. */
    readonly capability: string;
    /** Catalog dataset ids that the capability cannot run without. */
    readonly datasets: readonly string[];
}[];
```

Two tests pin it. Each `capability` value must be a phrase of the same agent. Each `datasets` value must be an id of the reference catalog. Thus a renamed phrase or a renamed dataset breaks the build instead of a run.

### A step names its capability, and the launch resolves the ids

A plan step gains an optional `capability` field. It carries one phrase of the assigned agent, copied from the rendered catalog. The planner already reads those phrases to select the agent, thus the field costs it one copy.

The launch then resolves the requirement with no judgment: the agent of the step gives the declaration, the phrase selects the entry, and the ids go to the store. A step with no phrase, and a phrase with no declaration, demand nothing.

The alternative is a `references` field that holds the ids. It is rejected for two reasons. The planner would resolve the ids itself, which repeats the declaration and can disagree with it. The ids would also reach the step schema, which the planner prompt renders, and a prompt must name no dataset.

### The ad-hoc path takes the same route

An ad-hoc request becomes a persisted plan before it runs (`src/tools/execute-analysis.ts`, `persistedAdHocPlan`). The ad-hoc router selects the agent from the same plannable catalog, thus it can name the capability on the step that it builds. The launch then resolves the requirement for an ad-hoc run and for a planned run alike, with one pass.

### The pre-launch pass is the place, and the refusal names each id

The check joins the pass that links the packages (`src/tools/execute-analysis.ts`). The store state can change between the plan and the launch, thus the launch is the last honest moment. `PlanReferencesMissingError` carries the absent ids, in the shape of `PlanPackagesMissingError`. It names no remedy command, because the remedy belongs to the embedder.

The cli maps it to the conflict reason `references_missing` with the ids, beside `packages_missing` (`cli/src/server/routes/runs.ts:470`). Thus the chat agent reads which datasets are absent, and its own rule tells it to offer the install that it can already run.

A plan validation before the approval is rejected as the only place. A user who approves a plan that cannot run has lost nothing yet, and the store can change after the approval.

### One tool answers a requirement, thus no prompt names a dataset

The chat agent learns of a requirement through a tool. A tool carries its own description into the context, and a prompt must name no dataset. The tool lists each declared requirement with its capability phrase, its agent, and the state of each dataset in the live store.

It takes no query. Only a data-hungry capability declares a requirement, thus the declarations are few. The whole list is small, and a filter would hide the entry that matters. The answer names the absent ids, which is what an install command takes.

The alternative is to extend `list_available_refs`. It is rejected, because that tool answers what the store holds, and this question is what a capability wants.

### The matched negative capability is the first consumer

Its phrase declares the six datasets of the method: `string-aliases-human`, `mgi-mouse-human-homology`, `impc-phenotyping`, `hpo-annotations`, `opentargets-mouse-phenotype`, and `opentargets-target-safety-event`.

The expression table, the network, the gene tables, and the GO collection stay out of the declaration. Each one is recommended, thus a default store holds it. A declaration of a recommended dataset would refuse a launch for a store that an embedder already provisions.

## Risks / Trade-offs

- [A phrase in a step can drift from the phrase in the metadata.] → The launch ignores a phrase that matches no declaration. Thus a drifted phrase loses the check, and it never refuses a sound plan. The test that pins each phrase keeps the metadata honest.
- [The planner can omit the field.] → Then the launch demands nothing, and the step reports the absent source as it does today. The field raises the floor, and it does not lower it.
- [A declaration can go stale when a method changes.] → The declaration sits beside the capability phrase, and the skill names the same data. A review of either reads both.
- [The chat agent can still design a method of its own.] → Out of scope. This change gives it the names, and it does not change the prompt that governs its judgment.

## Migration Plan

No migration. Each new field is optional, thus a stored plan parses as it does today. A store needs no change. An embedder that maps no new refusal sees the launch behave as before. The refusal occurs only for a plan that declares a capability with an absent dataset.

## Open Questions

None.
