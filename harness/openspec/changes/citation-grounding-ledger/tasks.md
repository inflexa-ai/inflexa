# Tasks: citation-grounding-ledger

## 1. The ledger primitive

- [ ] 1.1 Make `src/citations/ledger.ts` with `createCitationLedger()`, `add(pmids)`, and `has(pmid)`
- [ ] 1.2 Add the extraction helper: the `pmid` key walk and the `PMID: <digits>` contextual match
- [ ] 1.3 Write the unit tests for the three extraction scenarios of the `citation-grounding` spec

## 2. The reviewer ledger contribution

- [ ] 2.1 Add the optional `citationLedger` dependency to `createLiteratureReviewerTool`
- [ ] 2.2 After the child loop returns, extract the PMIDs from the inner `tool-result` parts and record them
- [ ] 2.3 Write the tests: an inner tool-result PMID enters the ledger, and a report-only PMID does not

## 3. The synthesizer gate

- [ ] 3.1 Add the ledger to `InnerToolContext`, and make one ledger per `generateRunSynthesis` call
- [ ] 3.2 Pass the ledger into the embedded reviewer tool of the loop
- [ ] 3.3 Add the grounding validation of `findings[].references[].pmid` and `keyReferences[].pmid` to `semanticCheck` and to `salvagedSemanticCheck`
- [ ] 3.4 Shape the rejection issue: name each ungrounded PMID, and point the hint at `literature_reviewer`
- [ ] 3.5 Extend `__buildInnerToolsForTest` with the ledger argument
- [ ] 3.6 Update `src/prompts/synthesis-agent.ts`: state that the gate is mechanical
- [ ] 3.7 Write the tests for the three gate scenarios of the `citation-grounding` spec

## 4. The analogical reasoner tool

- [ ] 4.1 Add `citationResolver` to `GenerateAnalogyReportDeps`, and add `resolve_citation` to `reasonerTools`
- [ ] 4.2 Pass the resolver at the conversation-agent call site of `createGenerateAnalogyReportTool`
- [ ] 4.3 Update `src/prompts/analogical-reasoner.ts`: name the tool for citation-identity verification

## 5. The target-assessment critique tool

- [ ] 5.1 Add `citationResolver` to `ExecuteTargetAssessmentDeps`
- [ ] 5.2 Add `resolve_citation` to the critique tool set at the `critiqueTools` build site
- [ ] 5.3 Pass the resolver in `assembleCoreRuntime`, in the same way as `usageRecorder`
- [ ] 5.4 Update the critique prompt: name the tool as the way to confirm a cited reference

## 6. Verification

- [ ] 6.1 Run `tsc -p tsconfig.json` in `harness/`
- [ ] 6.2 Run `bun test` in `harness/`
- [ ] 6.3 Run `bun run format:file` on each changed source file
