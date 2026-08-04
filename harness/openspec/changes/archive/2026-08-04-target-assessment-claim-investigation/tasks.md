## 1. Dossier contract

- [x] 1.1 Add the verdict, convergence, and uninvestigated-reason vocabularies to `src/contracts/target-dossier.ts`
- [x] 1.2 Add the mechanism-proposal, critique, and investigated-claim row schemas, each carrying claim support
- [x] 1.3 Add the coverage-enveloped `ClaimInvestigationSchema` (rows, completeness list, bounds in force)
- [x] 1.4 Add `claim_investigation` as a required top-level key on `DossierSchema`
- [x] 1.5 Extend `src/contracts/target-dossier.test.ts` with the section's own conformance assertions

## 2. Prompts

- [x] 2.1 Add `src/prompts/target-assessment/investigation/mechanism-proposal.ts`
- [x] 2.2 Add `src/prompts/target-assessment/investigation/adversarial-critique.ts` (critic system prompt)
- [x] 2.3 Add `src/prompts/target-assessment/investigation/claim-reverification.ts`
- [x] 2.4 Add the barrel; every prompt names tools rather than datasets, carries a "Do NOT" section, states that `unknown` is complete, and interpolates the canonical organ vocabulary

## 3. Investigation phase

- [x] 3.1 Add `src/workflows/target-assessment/investigation/index.ts` with the config bundle and its stated defaults
- [x] 3.2 Model-facing support schema plus the boundary resolver that drops locator-less evidence to `unknown`
- [x] 3.3 Propose step — single-shot `structuredLlmCall`
- [x] 3.4 Critique step — `runToTerminal` over `runAgent` with the literature tool and a `defineTool` terminal recorder, namespaced step names, `runStep` from the injected seam
- [x] 3.5 Re-verify step — single-shot `structuredLlmCall`
- [x] 3.6 Convergence loop with the stated bound and the three stopping conditions
- [x] 3.7 Deterministic completeness pass over budget-cut candidates, uncorroborated rollup organs, and failed investigations
- [x] 3.8 Coverage envelope selection, and budget-exceeded sentinel propagation

## 4. Workflow wiring

- [x] 4.1 Lift the corroboration fold into its own `ta-safety-corroboration` durable step in the workflow body
- [x] 4.2 Run the investigation between that step and Phase-5 synthesis; stamp both sections onto the dossier handed to synthesis and persist
- [x] 4.3 Drop the corroboration fold from `phase5-persist.ts`
- [x] 4.4 Emit `claim_investigation` as `not_loaded` from the Phase-4 orchestrator
- [x] 4.5 Expose the investigation bounds on `ExecuteTargetAssessmentDeps` and export the config type from the package barrel

## 5. Clinical-consequence annotator seam

- [x] 5.1 Thread a real `ClinicalConsequenceAnnotatorDeps` bundle from the workflow body into `phase4Assemble`
- [x] 5.2 Update the Phase-4 comments to describe the current state, with no pending-wiring note left behind

## 6. Tests and gates

- [x] 6.1 Unit-test the phase against a scripted chat provider: convergence bound, early settle, unknown support, completeness list, coverage states
- [x] 6.2 `npx tsc -p tsconfig.json --noEmit`
- [x] 6.3 `CORTEX_TEST_PG_URL=… bun test`
- [x] 6.4 `npx eslint src` (no new errors)
- [x] 6.5 `bun run format:file` on every changed `src/` file
- [x] 6.6 `openspec validate target-assessment-claim-investigation --strict`
