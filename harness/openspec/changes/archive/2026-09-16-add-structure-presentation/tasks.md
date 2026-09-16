## 1. Contract

- [x] 1.1 Add `contracts/structure-source.ts` with the `StructureSource` type and `parseStructureUrl(url)`. Apply the D3 grammar: `https`, the host `alphafold.ebi.ac.uk`, the path `/files/AF-{accession}-F{n}-model_v{k}.{pdb|cif}`, no query, no fragment. Map `.pdb` to `pdb` and `.cif` to `mmcif`. Add `alphafoldEntryUrl(accession)` and `alphafoldPredictionUrl(accession)`. Import nothing outside `contracts/`.
- [x] 1.2 Add the `structure` member to `PresentationContent` in `contracts/chat-parts.ts`: `{ kind: "structure"; format: "pdb" | "mmcif"; url: string; provider: "alphafold"; accession: string; version: number }`. Write a doc comment that names `version` as the version that was shown.
- [x] 1.3 Mirror the member in `PresentationContentSchema` (`contracts/schemas/chat-parts.ts`). Use `z.url()` for `url` and `z.number().int().positive()` for `version`.
- [x] 1.4 Write the unit tests of the grammar. Each AlphaFold format admits. An isoform accession (`P38398-2`) admits. Each of these refuses: `http`, a different host, the prediction API path, the PAE image path, a `.bcif`, a query string, a fragment, and a `..` segment. The `format` comes from the extension.

## 2. Card builder

- [x] 2.1 In `buildPresentationCardData`, add the branch for `kind === "structure"`. Parse `input.url` with `parseStructureUrl`. If the parse is `null`, return `null`. If not, construct the content from the parse, with no spread of the raw input. Keep the `id` keyed to the raw input.
- [x] 2.2 Write the tests. A valid URL builds the normalized card. A refused URL gives `null`. Two builds of the same raw input share one id. The live build and a rebuild from a `structuredClone` of the input are deep-equal.

## 3. show_user

- [x] 3.1 Add `"structure"` to the `kind` enum. Add an optional `url` field. Its description must say: pass the `pdbUrl` or the `cifUrl` that `alphafold_prediction` returned, without a change. Only an AlphaFold DB file URL is accepted. The chat fetches the coordinates when the user views the card. Never read or paste the file.
- [x] 3.2 Widen `ShowUserOutput` with `{ shown: false; reason: "invalid_source" }`. Map a `null` builder result for a structure input to it. Keep the non-null assertion of the other kinds out of the structure branch.
- [x] 3.3 Extend the tool description. A 3-D structure from AlphaFold DB is shown by URL. An existing `.pdb` or `.cif` artifact stays with `show_file`.
- [x] 3.4 Write the tests. A structure call emits one `data-presentation` with the normalized content and returns its id. A refused URL returns `invalid_source` and emits nothing.

## 4. Agent guidance

- [x] 4.1 In the description of `alphafold-prediction.ts`, add the sentence that names `show_user(kind: "structure", url: pdbUrl | cifUrl)` as the display path. Keep the rule about file contents.
- [x] 4.2 In `prompts/conversation.ts`, section "Showing Things to the User", name the structure card and the `show_file` boundary for an artifact structure. Update the prompt test of the conversation agent if it pins the section.

## 5. Verify and ship

- [x] 5.1 Run `bun run format:file` on each changed file under `src/`. Run `tsc -p tsconfig.json` and `bun test`.
- [x] 5.2 Update `CONTEXT.md` and `README.md` where they list the presentation kinds or the display tools.
- [ ] 5.3 Bump the package version (a patch bump, 0.36.2). Publish. Record the version in the Lumen change and in the Cortex change, with the rollout order: Lumen first, then Cortex.
- [ ] 5.4 Note for `cli/`: `readPresentation` in `cli/src/modules/harness/artifact_open.ts` gets a `structure` case (an inline note with the AlphaFold entry link) in a separate change.

## Status notes

- 5.2: `CONTEXT.md` and `README.md` list no presentation kind and no display tool, thus no edit was necessary.
- 5.3: the version is 0.36.2 in `package.json`. The publish to npm is not done. The consumer pins wait for the publish.
- 5.4: the `cli/` reader still shows the kind as an inline note. The row with the entry link is a separate change.
