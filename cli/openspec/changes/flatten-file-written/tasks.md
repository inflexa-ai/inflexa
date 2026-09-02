# Tasks

## 1. The bus contract

- [x] 1.1 Re-export `ProvCallRef` in `src/types/prov.ts`, and drop
  `ProvSessionFileWriteRef`.
- [x] 1.2 Flatten `prov.file_written` in `src/types/events.ts`: add `model`,
  the `call` arm, the optional `call` ref, and the optional `step` ref.
- [x] 1.3 Remove `prov.session_file_written` from the union and from the
  telemetry projection. Project the generation arm, the tool, and the model
  on `prov.file_written`.

## 2. The bridge

- [x] 2.1 Remove the `file_tool` arm from `toCommandRef`.
- [x] 2.2 Emit `prov.file_written` with `generation: "call"` and the call
  ref for a file-tool producer group. Keep the registered file QNames.
- [x] 2.3 Stamp `model` and the step ref on the command-output and leaf
  file events.
- [x] 2.4 Map the session `write-file` event onto the flattened member,
  with the invocation id, the tool, and the optional thread id on the call
  ref.

## 3. The recorder and the lineage command

- [x] 3.1 Make sure that the recorder maps the flattened member through
  `toKernelEvent` with no host branch.
- [x] 3.2 Cover a document that holds the old pseudo-command shape and the
  new call shape in one lineage model. Make sure that both render as
  file-tool activities.
- [x] 3.3 Exclude the retired `file_tool` command shape from the
  kernel-compat replay set, because the current writer does not emit it.

## 4. The tests

- [x] 4.1 Update `prov_bridge.test.ts` for the call-generation emission and
  the flattened session mapping.
- [x] 4.2 Update the prov unit tests for the three generation arms.
