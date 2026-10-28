# Tasks

## 1. The prompt and the tool text

- [x] 1.1 Delete from `prompts/conversation.ts` the restatement of the `execute_analysis` schema, the paragraph on autonomous workflows, and the copy of the one-wait rule. The test "the one-wait rule of a run is in the description of inspect_run, not in the prompt" in `agents/test/conversation-agent.test.ts` covers the wait rule.
- [x] 1.2 Move the stale-plan guidance into the messages of `PlanNotFoundError`, `PlanMalformedError`, and `PlanValidationError` in `tools/execute-analysis.ts`. The tests in `tools/test/execute-analysis.test.ts` cover the error types. No test pins the message text.
- [x] 1.3 Cut the role, data, and run sections into "Data and Files" and "Analysis Runs". The approval-record test in `agents/test/conversation-agent.test.ts` covers the approval rule. The evals `write-derived-file`, `trivial-question-no-run`, `conceptual-question-no-run`, `plan-request-no-run`, and `add-inputs-from-launch-dir` cover the run rule, the consent rule, and the input add.
- [x] 1.4 Cut the interpretation, translational, literature, hypothesis, and analogy sections to judgment. The eval `literature-search` covers the lookup rule.
- [x] 1.5 Cut the report section to the session path. Delete "Showing Things to the User", and fold the errors, "Do NOT", and guidelines sections into "Ground Rules". The test "the prompt names the one report path" and the evals `report-on-request` and `summary-no-report` cover the report path.
- [x] 1.6 Name a `.pdb` or `.cif` structure that a step wrote in the `show_file` description (`tools/workspace/show-file.ts`). The test "the display tools name the structure card, and an artifact structure stays on show_file" covers it.

## 2. The evals

- [x] 2.1 Run the decision evals after each step, and compare each step with the step before it with `compare --fail-on-regression`. Make sure that each step passes 85/85 dev trials and 85/85 held-out trials.

## 3. The specs

- [x] 3.1 Run `openspec validate trim-conversation-prompt --strict` in `harness`, and make sure that it passes.

## 4. The checks

- [x] 4.1 Run `tsc -p tsconfig.build.json` in `harness`, and make sure that it passes.
- [x] 4.2 Run `bun test` in `harness`, and make sure that it passes.

## Workflow follow-up

- No open change touches the specs of this change, thus the archive order is free.
