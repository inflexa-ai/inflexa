# Tasks

## 1. The contract and the record

- [x] 1.1 Add the optional `carried_slots` entry to `TemplateContractSchema` in `src/tools/knowledge/client.ts`.
- [x] 1.2 Add the optional `slots` list to the schema of the decision record in `src/execution/step-methods.ts`.

## 2. The binding and the seed

- [x] 2.1 Read the decision records of the dependencies in `resolveTemplateContract` when the contract carries slots.
- [x] 2.2 Bind each `bind` slot in `bindTemplateContract`, before the settings of the step.
- [x] 2.3 Add `reported_fit` to `TemplateBrief`, and render the shown values and the reason for an absent record.
- [x] 2.4 Do not exclude a carried slot that a departure removes.

## 3. The tests

- [x] 3.1 Add the tests of a bound slot, a local slot, a shown path, and a slot with no value in the record.
- [x] 3.2 Add the tests of a setting that differs, and of a departure that removes a carried slot.
- [x] 3.3 Add the tests of no record, a record of a different template, and two records.
- [x] 3.4 Add the tests of a value that the slot does not take, and of a version that differs.
- [x] 3.5 Add the tests of a script that changed after its render, and of a record file that the read left out.