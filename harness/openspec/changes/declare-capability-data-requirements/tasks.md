# Tasks

## 1. The declaration

- [ ] 1.1 Add the optional `dataRequirements` field to `AgentMeta` in `harness/src/agents/sandbox/types.ts`. Each entry holds a capability phrase and the catalog dataset ids.
- [ ] 1.2 Declare the six datasets of the matched negative capability on `translational-safety-agent`.
- [ ] 1.3 Add a test that each declared id is an id of the reference catalog.
- [ ] 1.4 Add a test that each declared phrase is a `capabilities` phrase of the same agent.
- [ ] 1.5 Add a test that no declared id is a recommended dataset.
- [ ] 1.6 Add a test that `formatAgentCatalog` renders no dataset id.

## 2. The step field

- [ ] 2.1 Add the optional `capability` field to `AnalysisStepSchema` in `harness/src/schemas/workflow-state.ts`, with a description that names the catalog as its source.
- [ ] 2.2 Make the field mandatory on the planner output schema, at the place that makes `packages` mandatory. Keep it optional on the persistence schema.
- [ ] 2.3 Add the planner rule that the step carries the capability phrase of its assigned agent, verbatim.
- [ ] 2.4 Add a test that a stored plan without the field still parses.
- [ ] 2.5 Fill the field in the ad-hoc router, because an ad-hoc request becomes a persisted plan and it takes the same launch.

## 3. The pre-launch resolution

- [ ] 3.1 Resolve the declaration of each step inside the pass that links the packages, in `harness/src/tools/execute-analysis.ts`.
- [ ] 3.2 Add `PlanReferencesMissingError`, in the shape of `PlanPackagesMissingError`, with the absent ids and no remedy command.
- [ ] 3.3 Read the state of each dataset through the reference-store seam that the embedder binds.
- [ ] 3.4 Give one reason when the store cannot answer, and name no dataset as absent.
- [ ] 3.5 Add a test for an absent dataset, for a present dataset, and for a step with no phrase.

## 4. The tool

- [x] 4.1 Add the tool that lists each declared requirement with its agent, its phrase, and the store state of each dataset.
- [x] 4.2 Write its description so that a caller learns when to use it at attach time.
- [x] 4.3 Attach it to the conversation agent.
- [x] 4.4 Add a test that the answer names each absent dataset by its catalog id.

## 5. The embedder

- [ ] 5.1 Add the `references_missing` reason to the conflict shape in `cli/src/api/runs.ts`.
- [ ] 5.2 Map the refusal in `cli/src/server/routes/runs.ts`, beside `packages_missing`.
- [ ] 5.3 Append the install command of the cli to the refusal that the user sees.
- [ ] 5.4 Add a route test for the new conflict.

## 6. The checks

- [ ] 6.1 Run `tsc -p tsconfig.build.json` in `harness`.
- [ ] 6.2 Run `bun test` in `harness`.
- [ ] 6.3 Run `bun run typecheck` and `bun test` in `cli`, against the linked harness.
- [ ] 6.4 Run the agent-facing content review of the root `CLAUDE.md` on each new description.
