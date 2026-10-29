# Tasks

## 1. The code

- [x] 1.1 Refuse in the session-scoped mutator (`tools/workspace/mutator.ts`) each write under `data/inputs/` with the `read_only` data variant and a reason. Refuse also a landing whose real path is under the staged inputs. The tests in `tools/workspace/test/mutator.test.ts` cover a write, an edit, and a symbolic link.
- [x] 1.2 Name `read_only` in the descriptions of `write_file` and `edit_file`.

## 2. The specs

- [x] 2.1 Write the deltas of `run-event-stream`, `run-synthesis-outcome`, `literature-search`, `chembl-tools`, `pubchem-tools`, `step-interpretation-summary`, and `harness-workspace-tools` from the code. Edit the Purpose of `literature-search`, `chembl-tools`, and `pubchem-tools` directly.
- [x] 2.2 Run `openspec validate --strict` in `harness` for this change and for each open change, and make sure that each passes.
- [x] 2.3 In a scratch copy of `openspec/`, archive this change before the open changes, and after them. Make sure that the two orders give the same specs.

## 3. The checks

- [x] 3.1 Run `bun run typecheck` and `bun run lint` in `harness`, and make sure that each passes.
- [x] 3.2 Run `bun test` in `harness`, and make sure that it passes.

## Workflow follow-up

- The archive order with the open changes is free.
