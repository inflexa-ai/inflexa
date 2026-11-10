# Tasks

## 1. The contract

- [x] 1.1 Add the optional `settings_by_construction` list to `TemplateContractSchema` in `src/tools/knowledge/client.ts`.

## 2. The binding and the seed

- [x] 2.1 Add `done_by_script` to `TemplateBrief`, and render it as a block before the unbound settings.
- [x] 2.2 In `bindTemplateContract`, put a setting with the name and the value of an entry in `done_by_script`.
- [x] 2.3 List a different plan value as unbound, with the value that the script does.
- [x] 2.4 List a setting that a departure removes as unbound, with the reason that the script has no slot for it.

## 3. The tests

- [x] 3.1 Add the tests of a setting that the script does, and of a contract with no entry.
- [x] 3.2 Add the tests of a departure with a value and with no value.
- [x] 3.3 Add the tests of a boolean value, an entry with the name of a slot, and a version that differs.
- [x] 3.4 Add the test of the block in the template contract section.
