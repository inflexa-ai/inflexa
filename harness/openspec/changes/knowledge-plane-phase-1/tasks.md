# Tasks — Knowledge Plane, Phase 1

## 1. Rule records and the corpus

- [x] 1.1 Make `src/knowledge/rule-record.ts`: the Zod schemas for a rule record, the manifest, and the closed condition set
- [x] 1.2 Make `src/knowledge/evaluate-rule.ts`: pure evaluation of `applies` against profile facts, with the three outcomes
- [x] 1.3 Unit tests for the schemas and the evaluation, with `not_evaluable` and unknown-key cases
- [x] 1.4 Make the corpus at the repository root: `knowledge/manifest.json` plus `knowledge/rules/bulk-transcriptomics.json` and `knowledge/rules/statistical-modeling.json`
- [x] 1.5 Convert the DE method tree from `skills/bulk-transcriptomics/SKILL.md`, one record for each branch, with resolved DOI or PMID sources
- [x] 1.6 Convert the statistical-modeling rules (cross-validation discipline, cutpoint correction, Cox PH remedy, cross-step leakage), each with resolved sources
- [x] 1.7 Make sure that each record validates: a small script or test that loads the shipped corpus through the schema

## 2. The seam

- [x] 2.1 Make `src/knowledge/knowledge-base.ts`: the `KnowledgeBase` interface, the facts type, and the typed errors
- [x] 2.2 Make `src/knowledge/noop-knowledge-base.ts`: the absent-condition realization
- [x] 2.3 Make `src/knowledge/file-knowledge-base.ts`: load the manifest, validate the records, exclude and log an invalid record, and serve reads
- [x] 2.4 Make `src/knowledge/observe.ts`: the observation event type and the fire-and-forget wrapper
- [x] 2.5 Add `knowledge?`, `knowledgeDir?`, and `observeKnowledge?` to `CoreRuntimeDeps`, and add `resolveCompositionKnowledge` beside `resolveCompositionEyes` in `src/runtime/assemble.ts`
- [x] 2.6 Export the interface and the realizations from `src/index.ts`
- [x] 2.7 Unit tests: the resolution precedence, the invalid-record exclusion, the manifest refusal, and the observation wrapper contract

## 3. The tools

- [x] 3.1 Make `src/tools/knowledge/knowledge-tools.ts`: `createKnowledgeTools(deps)` with `knowledge_search` and `knowledge_read`, absent condition as data
- [x] 3.2 Attach the tools to the sandbox substrate in `src/agents/sandbox/shared.ts`, independent of `meta.skills`
- [x] 3.3 Attach the tools to the planner in `buildPlannerSearchTools`, with the citation-set recorder
- [x] 3.4 Unit tests for both tools, with a fixture corpus and with no source

## 4. The grounded plan contract

- [x] 4.1 Add the `grounding` field to `AnalysisStepSchema` in `src/schemas/workflow-state.ts`, optional on persistence, with a teaching description
- [x] 4.2 Make `src/schemas/validate-grounding.ts`: the citation-set membership test, the rule evaluation over the plan, and the issue shapes with code `grounding`
- [x] 4.3 Wire the gate as the third stage of `fullyValidate` in `src/tools/research/generate-plan.ts`, inert with no source
- [x] 4.4 Build the knowledge brief host-side in `generate_plan`, beside the two inventory blocks, capped, with the absence line
- [x] 4.5 Extend the planner prompt: cite from the brief and the knowledge tools, and revise on a `grounding` rejection
- [x] 4.6 Unit tests: the unreturned-citation rejection, the violated-reject feedback, the citation-free rejection under applicable rules, the inert path, and a historical plan parse

## 5. Verification

- [x] 5.1 Run `tsc -p tsconfig.json` and `bun test` in `harness/`, and repair what fails
- [x] 5.2 Run `bun run format:file` on each changed source file
- [x] 5.3 Validate the implementation against the artifacts with the `opsx:verify` workflow
- [ ] 5.4 Drive one end-to-end plan generation against the shipped corpus through the `harness:verify` skill. Confirm the four paths that no unit test reaches: the citation-honesty rejection loop, the advisories on an accepted plan, the corpus stamp on a stored citation, and the prior-plan block of an iterated plan
