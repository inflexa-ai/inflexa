# Tasks

## 1. The host copy

- [x] 1.1 Add `DECISION_RECORD_ROOT` and `stepDecisionRecordDir` to `src/workspace/paths.ts`.
- [x] 1.2 Add `landWithinRoot` to `src/tools/workspace/mutator.ts`. Refuse each agent write under `DECISION_RECORD_ROOT` as `read_only`.
- [x] 1.3 Add `DecisionRecordStore` and `createDecisionRecordStore` to `src/tools/workspace/decision-record.ts`.

## 2. The file tools

- [x] 2.1 Write the host copy after the copy in the step in `knowledge_template`.
- [x] 2.2 Read the host copy first in `noteScriptChange` and `reconcileScriptRecord`. Write a change note to both copies.
- [x] 2.3 Write the copy in the step again before `execute_command` runs a script, and name it in `decision_records_restored`.
- [x] 2.4 Give the record store to the step agents and to the conversation agent.

## 3. The readers

- [x] 3.1 Read the host copies in `readStepDecisionRecords`, and give each reader of the methods the record directory of the step.
- [x] 3.2 Add `restoreStepDecisionRecords`, and run it before the walk of the artifacts.

## 4. Verification of the package

- [x] 4.1 Add the tests in `src/tools/workspace/test/execute-command.test.ts`, `src/tools/workspace/test/edit-file.test.ts`, `src/tools/workspace/test/mutator.test.ts`, `src/tools/knowledge/test/knowledge-tools.test.ts`, and `src/execution/test/step-methods.test.ts`. Move the records of the tests of the readers to the record directory.
- [x] 4.2 Run `bun run format:file` on each changed file in `src/`. Then run the typecheck, the lint, `format:check`, `dupes`, and the tests of the harness and of the cli.
