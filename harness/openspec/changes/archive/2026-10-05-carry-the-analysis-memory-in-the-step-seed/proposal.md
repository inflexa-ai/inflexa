## Why

The conversation agent records the goal and the constraints of an analysis in working memory. A constraint from the user is a rule for the whole analysis. But a sandbox step agent never sees working memory. Its seed holds only the plan step, the workspace, the resources, the data orientation, and the upstream handoffs. Thus a step agent can break a rule that the user gave in the chat. The constraints of a plan step do not always hold that rule.

## What Changes

- Each step seed gets a read-only copy of the goal and the constraints of the working memory. Each constraint shows its origin, `user` or `agent`.
- The seed shows the copy in its own section, `## Analysis memory (read only)`. The heading is different from the `Constraints` section of the plan step. The section tells the agent to obey a constraint from the user. It tells the agent to use a constraint from the agent as context.
- The seed holds no hypothesis and no finding.
- The section obeys the caps of `WORKING_MEMORY_LIMITS`. A memory with no goal and no constraints gives no section.
- The harness reads working memory at the dispatch of each step, inside the checkpointed step `compose-step-seed:<stepId>`. Thus a replay gives the same seed.
- A new function, `gatherStepPackage`, does each read for the seed. `composeStepBriefing` stays a pure renderer.
- `ExecuteAnalysisDeps` gets the field `workingMemory`. `assembleCoreRuntime` gives it from the pool of the composition. An embedder does not give it.
- The orient core of the sandbox system prompt names the section. The system prompt stays a function of the agent type only.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-working-memory`: a step seed carries a frozen read-only copy of the goal and the constraints, read at the dispatch of each step.
- `sandbox-format-standards`: the step seed also carries the copy of the analysis memory.

## Impact

- `src/prompts/briefing.ts`: the type `StepMemory`, the field `memory` of `StepBriefing`, and the renderer `renderMemory`.
- `src/workflows/execute-analysis.ts`: `gatherStepPackage`, and the field `workingMemory` of `ExecuteAnalysisDeps`.
- `src/runtime/assemble.ts`: the bag of `buildExecuteAnalysis` omits `workingMemory`, and the assembly gives it.
- `src/prompts/sandbox-standards.ts`: one paragraph in "Your Briefing Is Authoritative".
- The embedder API does not change. An embedder that builds `ExecuteAnalysisDeps` directly, outside `assembleCoreRuntime`, must give `workingMemory`.
