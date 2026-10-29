## 1. Implementation

- [x] 1.1 Add the optional `request` to `AnalysisPlanSchema`, and omit it from `PlannerPlanSchema`.
- [x] 1.2 Set `request` from `researchQuestion` when `generate_plan` persists a plan.
- [x] 1.3 Snapshot `request` into `ExecuteAnalysisInput`, and pass it to the briefing of each step.
- [x] 1.4 Render `## The request of the analysis` after the task in `composeStepBriefing`.
- [x] 1.5 Tests: the stored request, the render, and the seed of a step.
