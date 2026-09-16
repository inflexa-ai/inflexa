# Show an AlphaFold model as an interactive 3-D structure card

## Why

`alphafold_prediction` returns the metadata of a predicted model and the URLs of its coordinate files. It returns nothing that a user can look at. The conversation agent can describe in prose that BRCA1 is largely disordered. But the fold itself has no display path. `show_user` carries five text-shaped or vector-shaped kinds: `echart`, `markdown`, `code`, `svg`, and `table`. `show_file` references a workspace artifact only.

Today the only way to see a model is a sandbox step that downloads the file. The chat then shows that file as an unsupported binary.

## What Changes

- `PresentationContent` gets a sixth kind, `structure`. It is a versioned coordinate-file reference into AlphaFold DB that the harness normalized: `{ kind: "structure", format, url, provider: "alphafold", accession, version }`.
- `show_user` accepts `kind: "structure"` with one new field, `url`. The agent passes the `pdbUrl` or the `cifUrl` that `alphafold_prediction` returned, without a change. The tool refuses a URL of a different shape with a new `invalid_source` outcome. Admission is a path grammar over one host, not a free URL field.
- `buildPresentationCardData` parses and normalizes the URL, the same as it normalizes an echart spec. It does this in the single construction site. Thus the live card and the rebuilt card are identical, and the persisted transcript never holds a URL that the grammar refused.
- A browser-safe contract module, `contracts/structure-source.ts`, owns the URL grammar and the derived AlphaFold URLs. Thus a host applies the identical rule at render time, and it never reconstructs the rule.
- The description of `alphafold_prediction` and the prompt section "Showing Things to the User" name the card as the display path. Thus the agent does not start a sandbox download to show a structure.

## Capabilities

### New Capabilities

- `structure-presentation`: the `structure` presentation kind. It covers the wire shape, the URL admission grammar, the normalization in the card builder, and the `show_user` contract for the kind.

### Modified Capabilities

- `alphafold-tools`: the tool description names the display path.

## Impact

Harness source:

- `src/contracts/chat-parts.ts` and `src/contracts/schemas/chat-parts.ts`: the new union member and its Zod schema.
- `src/contracts/structure-source.ts` (new): the grammar and the derived URLs. The module imports nothing outside `contracts/`.
- `src/memory/card-builders.ts`: the normalization and the refusal for the new kind.
- `src/tools/display/show-user.ts`: the `kind` enum, the `url` field, and the `invalid_source` outcome.
- `src/tools/bio/alphafold-prediction.ts` and `src/prompts/conversation.ts`: one sentence each.

Consumers. The change adds to the wire and removes nothing. A Lumen that is typed for the previous contract drops the new kind at its Zod boundary. `parseChatFrame` and `parseCortexPart` return `null` for an unknown `kind`. There is no crash and no card. Thus the rollout order is: publish the harness, then bump Lumen (it gets the renderer), then bump Cortex (it gets the emitter).

Nexus changes nothing. AlphaFold DB serves `/files/*` with `Access-Control-Allow-Origin: *`. A GET test on the `.pdb` and `.cif` files of four accessions confirmed this. Thus the browser fetches the coordinates directly.

The CLI (`cli/`, in this repository) reads a presentation payload in `artifact_open.ts`. It shows an unknown kind as a visible inline note. A row with the entry link for the new kind is a separate change in `cli/`, the same as for the earlier contract additions.

Out of scope:

- RCSB and PDBe sources. Both serve CORS `*` too. Each is one grammar row when a tool returns their URLs.
- A workspace-artifact variant of the card. An existing `.pdb` or `.cif` is the job of `show_file`, and the structure file-kind of the host renders it.
- Residue highlights and molecular surfaces.
- A snapshot of the coordinate bytes into the analysis workspace. See design decision D6.
