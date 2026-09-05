## 1. The client seam

- [x] 1.1 Declare `KnowledgeClient`, the situation type, and the lenient answer schemas in `src/tools/knowledge/client.ts`.
- [x] 1.2 Ship `createHttpKnowledgeClient` over `apiFetchValidated`, with `unavailable` and `rejected` as data variants.
- [x] 1.3 Test the client against a stub service: an answer, a 400, a 401, a 500, and an unreachable host.

## 2. The three tools

- [x] 2.1 `knowledge_recommend` over the flat situation schema, with the contract in its description.
- [x] 2.2 `knowledge_check` over the situation plus the drafted steps.
- [x] 2.2.1 The per-plan check cap, and the optional `outcome` of a drafted step.
- [x] 2.3 `knowledge_template` over the mutator, with the farm versions from the lock, in workflow execution mode.
- [x] 2.4 `createKnowledgeTools` gives the two planner tools or nothing.
- [x] 2.5 Test the three tools with a fake client and a real mutator over a temporary tree.

## 3. The registrations

- [x] 3.1 `GeneratePlanDeps.knowledge` and the two tools in the planner search list.
- [x] 3.2 `ConversationAgentDeps.knowledge`, passed to the planner.
- [x] 3.3 `knowledgeTemplate` in `SandboxToolName`, declared by the bulk transcriptomics agent and the enrichment agent, resolved over the mutator, absent without a client.
- [x] 3.4 `knowledge_template` in `MutateToolName`.
- [x] 3.5 The factories and the types on the public barrel.

## 4. The grounding field

- [x] 4.1 `GroundingSchema` and the optional `grounding` on `AnalysisStepSchema`.
- [x] 4.2 The field in `STEP_TASK_FIELDS` and its rendering in the briefing.
- [x] 4.3 The field on the presentation `PlanStepSchema`.
- [x] 4.4 The coverage guard test covers an object-valued field.

## 5. Verification

- [x] 5.1 `tsc --noEmit` and `bun test` green.
- [x] 5.2 The catalog test counts the allowlist member that resolves to nothing without a client.
