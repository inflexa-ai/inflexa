# An ad-hoc step declares its packages, and the link pass runs for it

## Why

Issue #521 reports that an ad-hoc launch bypasses the pre-launch package
check. `buildAdHocPlan` writes its one step without a `packages` key
(`src/tools/execute-analysis.ts:244-277`). The link pass makes a union of
`step.packages ?? []`, and it finds nothing. Thus it returns before the seam
call (`execute-analysis.ts:134-147`). Ad-hoc is the path that the agent takes when
the user says "run it". Thus the refusal that names a missing or ambiguous
spelling never fires for that path, and each miss shows at import time,
mid-step, after spend. The sandbox briefing withholds `packages` on the
premise that the link pass consumed them, and that premise is false for an
ad-hoc step.

## What Changes

- The ad-hoc router emits a `packages` array beside the specialist and the
  resources. The router prompt teaches the one package grammar through the
  same section that the planner prompt uses.
- The router validates the package entries independently from the agent and
  the resources. An entry that does not parse is dropped. A package failure
  never changes the selected agent or the resources.
- The router gets an optional targeted resolution of the names that it emits.
  A name that the pool does not hold is dropped, and a name with a known
  spelling takes that spelling. A name that both tracks hold stays bare, and
  the link pass refuses it with the prefixed remedy, the same as a plan step.
  No census reaches the router.
- `buildAdHocPlan` writes `packages` on the step. A caveat names each dropped
  entry with its reason. When the step declares no packages, a caveat says so,
  because the link pass then links nothing.
- The `analysis launched` log record carries the count of the package queries
  that the link pass sent.
- The inventory read of `list_available_packages` becomes an exported
  function, so that the launch path resolves names against the same source.
- `ExecuteAnalysisToolDeps` gains the three optional inventory fields, and the
  conversation agent passes them, the same as it does for `generate_plan`.
- The briefing comment that withholds `packages` states a premise that holds
  for every step.

No CLI change. The CLI has no ad-hoc path of its own. The TUI chat calls the
harness `execute_analysis` tool, and the CLI binds the seam on the
conversation agent. Thus the CLI gets the check through this change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `adhoc-analysis-execution`: the requirement "Utility router selects a
  specialist and resources" gains the package output, its validation, and the
  targeted resolution. The requirement "Internal plan is mechanical and not
  an approval artifact" gains the `packages` array and the caveats.

## Impact

- `src/tools/ad-hoc-router.ts`: the schema, `AdHocRoute`, the prompt, the
  validation, the resolution dep, and the log record.
- `src/prompts/planner.ts`: the packages section becomes an exported
  function. The planner prompt keeps the same text.
- `src/tools/execute-analysis.ts`: `ExecuteAnalysisToolDeps`,
  `persistedAdHocPlan`, `buildAdHocPlan`, `linkPlanPackages`, and the launch
  log.
- `src/tools/sandbox/list-available-packages.ts`: the inventory read becomes
  `readInventorySections`.
- `src/agents/conversation-agent.ts`: three deps flow into the tool.
- `src/prompts/briefing.ts`: one comment.
- Tests: `ad-hoc-router.test.ts`, `execute-analysis.test.ts`, and the
  planner prompt test stays green.
- Embedders: the new deps are optional and additive. `createExecuteAnalysisTool`
  is not in `src/index.ts`, and the conversation agent already receives the
  three inventory deps. Thus no embedder changes.
- Behavior in Cortex: the seam is bound on the conversation agent only, and it
  links nothing. A refusal there is terminal, and a dropped absent name
  prevents a run that fails at import.
