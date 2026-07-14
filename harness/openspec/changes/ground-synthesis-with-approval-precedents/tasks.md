# Tasks — ground synthesis with FDA approval precedents

## 1. Retrieval + render module

- [x] `workflows/target-assessment/lib/approval-precedents.ts`:
  `fetchApprovalPrecedents` (openFDA fetch + TTL cache + 404-means-empty),
  `renderApprovalPrecedents` (the `## FDA approval precedents` block, incl. the
  empty / no-indication notes), `pickIndicationForPrecedents` (top indication by
  `composite_score`, else `inferred_therapeutic_area`, else null)
- [x] Delete the orphan `tools/bio/find-approval-precedent.ts` + its bio-barrel export

## 2. Wire into synthesis

- [x] `SynthesisAgentDeps.approvalPrecedents`; append the block to all four
  synthesis prompts
- [x] `execute-target-assessment.ts`: pre-synthesis `DBOS.runStep("ta-approval-precedents")`
  that resolves the indication, queries once (a lookup failure is non-fatal), and
  feeds the rendered block into `synthesisDeps`
- [x] Rewrite the four briefs from "call `find_approval_precedent`" to "use the
  supplied `## FDA approval precedents` block"

## 3. Tests + specs

- [x] `approval-precedents.test.ts` — indication pick, render (null / empty /
  non-empty), fetch with mocked `fetch`
- [x] `target-synthesis-grounding` capability spec
- [ ] `openspec archive ground-synthesis-with-approval-precedents` once merged
