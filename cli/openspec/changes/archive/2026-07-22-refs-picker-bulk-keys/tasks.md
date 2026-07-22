## 1. Dependency

- [x] 1.1 Declare `@clack/core` in `cli/package.json` at the exact version `@clack/prompts@1.7.0` resolves (`1.4.3`), and confirm `bun install` adds no new package to the tree.

## 2. The picker

- [x] 2.1 Add `ReferencePickerModel` — grouped entries in catalog order, the offered id list, the recommended subset, and the footer text — built by an exported pure `referencePickerModel(catalog)`.
- [x] 2.2 Add the exported pure `referencePickerBulkSelection(char, model)`: `a` → every offered id, `n` → none, `r` → the recommended subset, `undefined` for any other key and for `r` when nothing offered is recommended.
- [x] 2.3 Render the picker by constructing `GroupMultiSelectPrompt` directly with a custom `render()` built from clack's exported symbols and `limitOptions`, opening with nothing selected and painting the key footer.
- [x] 2.4 Subscribe the bulk keys with `.on("key", …)` before `.prompt()`, relying on `onKeypress` repainting after the handler returns.

## 3. Disclosure and the on-demand note

- [x] 3.1 Add the exported pure `referenceSelectionDisclosure(withheld)` returning the already-installed count line when non-zero.
- [x] 3.2 Annotate an empty recommended key with the number of recommended datasets already installed, falling back to the neutral wording when none are.
- [x] 3.3 Store the note as unwrapped paragraphs wrapped at render time (`onDemandReferenceNote`), so the two layouts cannot drift and the command line is never reflowed.
- [x] 3.4 Add `onDemandReferencePanel(width)` — the bordered box, returned unstyled so its layout is assertable — and `referenceNoteFloats(columns)`, the single width decision `chooseIds` makes for both the printer and the renderer.
- [x] 3.5 Paint the panel down the right of the listing: reserve its columns through `limitOptions`' `columnPadding`, pad rows to a fixed gutter measured on stripped text, and extend the rows when the panel is taller.

## 4. Wiring

- [x] 4.1 `runReferenceSetup` passes the offered catalog plus the withheld (installed) datasets it already holds from `inspectReferenceStore`.
- [x] 4.2 `downloadReferences` with no ids on an interactive terminal inspects the store once and withholds installed datasets, except under `--force`, where every dataset is offered.

## 5. Removals

- [x] 5.1 Delete `ReferencePreset`, `ReferencePresetOption`, `ReferencePresetPrompt`, `referencePresetPrompt`, and `resolveReferencePreset`; drop the now-unused `select` import.

## 6. Tests

- [x] 6.1 Replace the preset tests with picker-model tests: group order, labels, recommended hints, the offered id list, and the footer in both recommended states.
- [x] 6.2 Cover `referencePickerBulkSelection` for `a`/`n`/`r`, unknown keys, case, and `r` with nothing recommended (selection untouched).
- [x] 6.3 Cover `referenceSelectionDisclosure` and the annotated legend, including the recommended-set-is-installed case that produced the report and the offer that never had one.
- [x] 6.4 Assert the note names both routes, reads as guidance before the fact, wraps to any width, and keeps the command line unbroken.
- [x] 6.5 Cover `onDemandReferencePanel` (uniform width, closed border, every interior line bordered) and `referenceNoteFloats` at its threshold.

## 7. Verification

- [x] 7.1 `bun run lint`, `bun run typecheck`, `bun test` in `cli/`.
- [x] 7.2 Drive the real picker under a pty against a throwaway `XDG_DATA_HOME`: `a`, `n`, `r`, group toggling, and cancel.
- [x] 7.3 Seed a throwaway store with every recommended dataset installed and drive the picker again, confirming the reported state end to end: the installed count above, the annotated key below, and `r` leaving an existing selection untouched.
- [x] 7.4 `bun run format:file` on every changed file under `src/`.
