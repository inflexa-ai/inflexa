# Tasks

## 1. The lookups of the synthesizer

- [x] 1.1 Add `createSynthesisLookupTools` in `harness/src/tools/research/synthesis-lookups.ts`, and export it through the research barrel. The tests of the run workflow build the synthesis deps with it.
- [x] 1.2 Build the lookups one time in `runtime/assemble.ts`, with the bio keys of the embedder and the shared citation resolver. Pass them as `synthesisLookups` through `ExecuteAnalysisDeps` and `SynthesizeRunDeps` into `generateRunSynthesis`. `app/test/synthesize-run.test.ts` and `workflows/test/execute-analysis.test.ts` cover the wiring.
- [x] 1.3 Declare `submit_synthesis`, `report_blocker`, the lookups, and `read_tool_output` on the synthesizer, and set `SYNTHESIZER_MAX_ITERATIONS` to 40. The test of the declared tools in `execution/test/run-synthesis.test.ts` covers it.

## 2. The PMID refusal

- [x] 2.1 Add `pmidsIn`, which skips the echo keys, and `recordingPmids`, which attaches the PMIDs as a call record. The `pmidsIn` tests in `execution/test/run-synthesis.test.ts` cover it.
- [x] 2.2 Make `submit_synthesis` refuse each numeric PMID that no lookup of the run returned. The tests of the refusal, and of the acceptance after a lookup, cover it.
- [x] 2.3 Do a DBOS test of a crash after a lookup and an accepted submission. `workflows/__tests__/dbos/test/synthesis-recovery.test.ts` expects `produced`, and one run of the lookup.

## 3. The prompt and the schema

- [x] 3.1 Tell the synthesizer in `prompts/synthesis-agent.ts` to look up its evidence itself. State that each cited PMID must be in a lookup result of the run. The blocker discipline tests cover the prompt.
- [x] 3.2 Make the description of `LiteratureReferenceSchema.pmid` in `schemas/run-synthesis.ts` name a lookup result of the run as the source.

## 4. The removal

- [x] 4.1 Delete `tools/research/literature-reviewer.ts`, `prompts/literature-reviewer.ts`, and the reviewer test. Remove the reviewer budget. `runtime/test/assemble.test.ts` no longer expects `sub-agent.literature-reviewer`.
- [x] 4.2 Remove `delegationCount` from `SynthesisProgressPart`, its schema, `synthesizeRun`, and `synthesisEmission`. `sandbox/test/sandbox-step-translate.test.ts` covers it.
- [x] 4.3 Move each test that used the reviewer as a sample sub-agent to the analogical reasoner or to the lookups. The changed tests include `loop/test/usage-accounting.test.ts`, `workflows/test/step-seed.test.ts`, and `workflows/__tests__/dbos/test/run-pause.test.ts`.

## 5. The documents

- [x] 5.1 Replace the Literature Reviewer entry of "Key Components" in `harness/CLAUDE.md` with the run synthesizer, and remove the reviewer child from the `executeAnalysis` entry.
- [x] 5.2 Replace the reviewer in the sub-agent examples of `harness/CONTEXT.md` with the planner.
- [x] 5.3 Run `openspec validate remove-literature-reviewer --strict` in `harness`, and make sure that it passes.

## 6. The checks

- [x] 6.1 Run `tsc -p tsconfig.build.json` in `harness`, and make sure that it passes.
- [x] 6.2 Run `bun test` in `harness`, and make sure that it passes.

## Workflow follow-up

- The delta removes each requirement of `literature-reviewer`. The archive deletes its spec, because `.openspec.yaml` declares `retire_capabilities: true`. At a sync by hand, delete `openspec/specs/literature-reviewer/spec.md`.
