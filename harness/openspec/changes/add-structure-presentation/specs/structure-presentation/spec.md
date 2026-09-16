## ADDED Requirements

### Requirement: A structure presentation kind names one versioned AlphaFold model file

`PresentationContent` MUST carry a `structure` member of the shape `{ kind: "structure"; format: "pdb" | "mmcif"; url: string; provider: "alphafold"; accession: string; version: number }`. The `url` is the coordinate file that the card shows. The `format` comes from the URL. The `accession` and the `version` are the values that the harness derived from the URL. The `version` is the model version that was shown, and a host MUST NOT rewrite it. The Zod schema in `contracts/schemas/chat-parts.ts` MUST mirror the member. The new module MUST import only `zod` or a module under `contracts/`, thus `contracts/` stays a leaf.

#### Scenario: The wire shape validates

- **WHEN** `{ kind: "structure", format: "mmcif", url: "https://alphafold.ebi.ac.uk/files/AF-P38398-F1-model_v6.cif", provider: "alphafold", accession: "P38398", version: 6 }` is validated against `PresentationContentSchema`
- **THEN** it parses, and `version` is a positive integer

#### Scenario: A missing derived field is rejected

- **WHEN** a `structure` content without `accession` or without `version` is validated
- **THEN** the schema rejects it

### Requirement: Admission is a path grammar over one host, shared with the host

`contracts/structure-source.ts` MUST export `parseStructureUrl(url: string): StructureSource | null`. The function MUST admit exactly a URL with the scheme `https`, the host `alphafold.ebi.ac.uk`, the path `/files/AF-{accession}-F{n}-model_v{k}.pdb` or `.cif`, no query, and no fragment. For an admitted URL it MUST return `{ provider: "alphafold", accession, version: k, format, url }`, with the `format` `pdb` for `.pdb` and `mmcif` for `.cif`. For each other input it MUST return `null`. The module MUST also export `alphafoldEntryUrl(accession)` and `alphafoldPredictionUrl(accession)`. Thus a host derives the entry page and the re-resolution endpoint from the card, and not from its own string.

#### Scenario: Both AlphaFold formats admit

- **WHEN** `parseStructureUrl` is given `https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.pdb` and then the `.cif` sibling
- **THEN** both return a source with `accession: "P69905"`, `version: 6`, and `format` `pdb` then `mmcif`

#### Scenario: An isoform accession admits

- **WHEN** the path names `AF-P38398-2-F1-model_v6.cif`
- **THEN** the source carries `accession: "P38398-2"`

#### Scenario: The same host outside the grammar refuses

- **WHEN** the URL is the prediction API (`/api/prediction/P38398`), the PAE image (`…-predicted_aligned_error_v6.png`), the binary `.bcif`, or a file URL with a query string
- **THEN** `parseStructureUrl` returns `null`

#### Scenario: A different host or scheme refuses

- **WHEN** the URL uses `http`, or names a host other than `alphafold.ebi.ac.uk`
- **THEN** `parseStructureUrl` returns `null`

### Requirement: The card builder normalizes a structure and refuses what the grammar refuses

For `kind: "structure"`, `buildPresentationCardData` MUST run `parseStructureUrl` over the input `url`, and it MUST construct the content from the parse. It MUST NOT spread the raw input. If the parse is `null`, the builder MUST return `null`, on the live path and on the reconstruct-on-read path. Thus a refused URL never returns as a card from the persisted `tool_use` input. The card `id` MUST stay keyed to the raw input.

#### Scenario: A live card and its replay are identical

- **GIVEN** a `show_user(kind: "structure", url)` call rendered live and the same card later rebuilt from the persisted input
- **WHEN** both cards are compared
- **THEN** their content deep-equals and their ids match

#### Scenario: A refused URL builds no card

- **WHEN** the builder is given `{ kind: "structure", url: "https://example.org/model.pdb" }`
- **THEN** it returns `null`

#### Scenario: A stray field does not ride along

- **WHEN** the input also carries `body` or `spec`
- **THEN** the built content holds exactly `kind`, `format`, `url`, `provider`, `accession`, and `version`

### Requirement: show_user accepts a structure by URL and reports a refused source as data

The input schema of `show_user` MUST list `"structure"` in `kind`. It MUST carry an optional `url` string. The description of `url` MUST say that the agent passes the `pdbUrl` or the `cifUrl` that `alphafold_prediction` returned, without a change. The tool MUST emit one `data-presentation` part with the normalized content, and it MUST return `{ id }`. If the builder refuses the URL, the tool MUST return `ok({ shown: false, reason: "invalid_source" })`, and it MUST emit nothing. That is an expected outcome that the model can correct, not an `err` and not a throw.

#### Scenario: An AlphaFold URL becomes a card

- **WHEN** the agent calls `show_user(kind: "structure", title: "BRCA1 — AlphaFold model", url: <the cifUrl of the tool>)`
- **THEN** one `data-presentation` part is emitted whose content is the normalized structure, and the tool returns its id

#### Scenario: A foreign URL is refused as data

- **WHEN** the agent calls `show_user(kind: "structure", url: "https://files.rcsb.org/download/1YCR.cif")`
- **THEN** the tool returns `{ shown: false, reason: "invalid_source" }` and emits no part

#### Scenario: The same call two times resolves to the same card

- **WHEN** an identical structure call is made again
- **THEN** the emitted part carries the same id as the first emission

### Requirement: The agent is told where a structure is shown

The description of `alphafold_prediction` MUST name `show_user(kind: "structure", url)` with `pdbUrl` or `cifUrl` as the way to show the predicted structure. The description MUST keep its rule that the tool never returns file contents, and that the agent never reads the file to show a structure. The section "Showing Things to the User" of the conversation prompt MUST name the structure card, and it MUST keep an existing `.pdb` or `.cif` artifact on `show_file`.

#### Scenario: The description names the display path

- **WHEN** the `alphafold_prediction` tool definition is read
- **THEN** its description names `show_user` with `kind: "structure"` and the URL fields to pass

#### Scenario: An artifact structure stays on show_file

- **WHEN** a step wrote `runs/run-abc/step-1/output/model.pdb` and the agent wants to show it
- **THEN** the prompt directs it to `show_file`, not to `show_user(kind: "structure")`
