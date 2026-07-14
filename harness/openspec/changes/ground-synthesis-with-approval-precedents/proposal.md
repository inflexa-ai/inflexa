# Ground target-assessment synthesis with FDA approval precedents

## Why

The four target-assessment synthesis briefs (`liability-bullets`,
`target-organ-liabilities`, `translational-commentary`,
`executive-recommendation`) instruct the model to **call** `find_approval_precedent`
to ground class-precedent and disposition claims against real FDA approvals. But
Phase-5 synthesis runs through `structuredLlmCall` — a single-shot forced-`submit`
call that can invoke NO tool. So every one of those tool-call instructions failed
silently, and `find_approval_precedent` was a defined-but-unrostered orphan tool.
The briefs promised regulator-grounded synthesis the code never delivered.

This resolves Decision 1 of the archived `resolve-harness-wiring-gaps` audit
(option A: pre-synthesis retrieval).

## What Changes

Wire the grounding **deterministically**, keeping synthesis single-shot:

- A pre-synthesis `DBOS.runStep` (`ta-approval-precedents`) resolves the dossier's
  candidate indication (top `indications` row by `composite_score`, else the
  target header's `inferred_therapeutic_area`), queries openFDA / Drugs@FDA once,
  and renders a `## FDA approval precedents` markdown block (a "no precedents /
  no indication" note when empty). A precedent-lookup failure is non-fatal — it
  degrades to the empty note rather than failing the assessment.
- The block is threaded into `SynthesisAgentDeps.approvalPrecedents` and appended
  to all four synthesis prompts. The briefs are rewritten from "call
  `find_approval_precedent`" to "use the supplied `## FDA approval precedents`".
- The `findApprovalPrecedent` `defineTool` wrapper is removed (no agent rosters
  it); its openFDA fetch becomes a plain `fetchApprovalPrecedents` function
  co-located with the synthesis, so no orphan tool remains.

## Impact

- Code: new `workflows/target-assessment/lib/approval-precedents.ts`
  (`fetchApprovalPrecedents`, `renderApprovalPrecedents`,
  `pickIndicationForPrecedents`); deleted `tools/bio/find-approval-precedent.ts`
  + its bio-barrel export; `workflows/target-assessment/synthesis/index.ts`
  (thread `approvalPrecedents`); `workflows/execute-target-assessment.ts` (the
  pre-retrieval step); the four brief prompts.
- Specs: new `target-synthesis-grounding` capability.
- No change to the single-shot synthesis contract or the target-assessment 402
  pause path.
