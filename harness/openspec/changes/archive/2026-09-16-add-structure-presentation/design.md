# Design — structure presentation

## Context

Two display mechanisms exist. `show_user` inlines agent-composed content on the wire. For `echart`, it can name a workspace CSV (`dataPath`) that the host loads at render time. `show_file` references a workspace artifact by an analysis-rooted path, and the host resolves a presigned URL from Nexus. One rule binds both, in the prompt and in each tool description: select the tool by what you reference, never by how the output looks.

`alphafold_prediction` returns URLs into a third place, a public database. Its docstring says that a download belongs in the sandbox. That rule is correct for coordinates that the model would read into its context window. It is the wrong path to show a structure. A sandbox round-trip costs a pod for one display, and the file that it lands is a binary that the chat cannot render.

These facts were confirmed before this design was fixed:

- AlphaFold DB `/files/*` answers a cross-origin GET with `access-control-allow-origin: *`. The test made 12 requests over four accessions and both formats. A preflight `OPTIONS` also answered `*`. RCSB (`files.rcsb.org`) and PDBe (`www.ebi.ac.uk/pdbe/entry-files`) answer the same.
- AlphaFold DB removes a superseded model version. For P69905 (`allVersions: [1..6]`) the `_v1`, `_v3`, `_v4`, and `_v5` files answer 404. Only `_v6` serves. Thus a persisted versioned URL breaks on the next AlphaFold release.
- The prediction API (`/api/prediction/{accession}`) also answers cross-origin. Thus a host can resolve an accession to the current file URLs without a server hop.
- Lumen validates each `data-*` frame against `CortexChatPartSchema`, and it drops a part that fails. An unknown `kind` in the discriminated union is a drop, not an error.
- The conversation agent writes its own workspace files at the analysis root. Nexus resolves an artifact download URL by `(run, path)` only. Thus `show_file` cannot show a file that the conversation agent writes outside `runs/`.
- 3Dmol.js, the viewer of the host, reads pLDDT from the PDB B-factor column and from the mmCIF `B_iso_or_equiv` field. Thus both AlphaFold formats color by confidence without an extra document.

## Goals / Non-Goals

**Goals:**

- The agent shows an AlphaFold model in one call, with data that it already holds: the URL that the tool returned. No file passes through its context window.
- The transcript records the exact file that was shown: the versioned file, not "what AlphaFold serves now".
- The harness admits only what it can name: one host and one path grammar. The host applies the identical rule.
- The live card and the rebuilt card are identical. A refused URL is refused on both paths.

**Non-Goals:**

- A fetch or a store of coordinate bytes in the harness or in the workspace (D6).
- A second structure source (RCSB, PDBe) before a tool returns one of their URLs. Each is one grammar row.
- Residue highlights, molecular surfaces, and ligand display. The agent does not need a render hint to show a fold.
- A workspace-artifact variant of the card (D5).

## Decisions

### D1 — A kind on `show_user`, not a fourth display tool

The alternative is `show_structure`, a tool of its own. That adds a roster entry, a `describeCall`, a tool-meta row in the host, and a fourth branch of the rule "select by what you reference". All of that carries one string.

A kind on `show_user` costs one enum value and one optional field on a flat schema. The card id, the emit path, the persistence, and the replay path come with it. The prompt rule gets half a sentence: `show_user` is for content that you composed or looked up, and that exists in no artifact. An echart with `dataPath` already extended "content that you invent" to "a reference that the host resolves at render time". A structure URL is the same shape of thing.

### D2 — The card carries the versioned URL that the agent named, plus the fields that the harness derived from it

Three shapes were compared:

- **The accession only**, resolved through the prediction API at render time. This is the simplest input. But the card drifts: today it shows v6, next year it shows v7, and the transcript no longer matches what the agent discussed.
- **The URL only.** This is exact and auditable. But the host then parses the URL to label the card and to recover from a removed version. That is the grammar again, in a second language.
- **The URL plus the derived fields** `format`, `provider`, `accession`, and `version`. The URL is what the host fetches and what the transcript attests to. The derived fields are what the host displays and what its fallback needs. The derivation happens one time, in the builder, from the one grammar.

The third shape is selected. The `version` of the card is the version that was shown. When the host substitutes a newer file (D6), it labels the substitution. It never rewrites the card.

### D3 — Admission is a path grammar, shared with the host

`parseStructureUrl(url)` in `contracts/structure-source.ts` admits exactly this shape: the scheme `https`, the host `alphafold.ebi.ac.uk`, the path `/files/AF-{accession}-F{n}-model_v{k}.{pdb|cif}`, no query, and no fragment. It returns `{ provider, accession, version, format, url }` or `null`. The format comes from the extension: `.pdb` gives `pdb`, and `.cif` gives `mmcif`. The binary `.bcif` is not admitted in this change. The host viewer has a binary decode path, but it gains nothing over the text file.

A host check alone (`hostname === "alphafold.ebi.ac.uk"`) admits each path on that host, which includes the API and the PAE image. The grammar names the one kind of object that the card can hold.

The module is under `contracts/`, and it imports nothing outside `contracts/`. Thus Lumen imports the same function. Lumen refuses to fetch a persisted card whose `url` the grammar no longer admits. That is defense in depth at zero duplication.

### D4 — The normalization and the refusal are in the builder

`buildPresentationCardData` is the single construction site of a `PresentationContent`. The echart normalizer runs there for the same reason (see the echart-layout spec). For `kind: "structure"` the builder runs `parseStructureUrl`, and it constructs the content from the parse. It does not spread the raw input. Thus a stray field from the flat `show_user` schema cannot ride along.

If the grammar refuses the URL, the builder returns `null`. On the live path `show_user` maps that to `ok({ shown: false, reason: "invalid_source" })`. That is an expected outcome that the model can correct, the same as `invalid_path` today. On the reconstruct-on-read path a `null` is the existing chip fallback. The transcript persists the raw `tool_use` input. Thus this rule stops a refused URL from a return as a card on reload.

The card `id` stays keyed to the raw input, as for each kind. The normalization cannot move the identity of a card.

### D5 — No workspace-artifact variant

`show_user(kind: "structure", dataPath: "runs/…/model.pdb")` was examined and rejected. It is a second way to show an existing artifact, against the rule of one tool for each source of truth. `show_file` already references the file. The file-kind table of the host gets `structure` for `.pdb`, `.ent`, `.cif`, and `.mmcif`, and the same viewer renders it. The only gain of a card variant is a color-mode hint (pLDDT or chain). The host gives that as a control on the viewer instead of a field that the agent must remember.

### D6 — The host recovers from a removed version. The harness does not snapshot bytes

AlphaFold DB removes a superseded version. Thus each persisted card will name a file that answers 404 at some time. Two answers were compared.

**A snapshot of the coordinates into the analysis workspace at show time.** This is durable, and the provenance tracks it. A later step can use the file again. But `show_user` is a pure emitter with no I/O. The conversation agent writes at the analysis root, where the Nexus artifact endpoint cannot resolve a file. To make such a file resolvable is Cortex-plus-Nexus plumbing: an artifact registration outside a run. That is a real capability, "the conversation agent files an artifact". Design it as one. Do not hide it behind a display card.

**A recovery at render time.** On a 404, the host calls the prediction API for the `accession` of the card. It takes the current URL of the `format` of the card, fetches it, and labels the card: "shows model v7, v6 is no longer published". The transcript still attests to v6. The user still sees a structure. Nothing is written. The cost is two extra requests, only on a failure, and only after a release upstream.

The second answer is selected for this change. The card shape (`accession`, `version`, `format`) makes it possible without a parse in the host. The snapshot is the follow-up if exact-bytes reproducibility becomes a requirement.

### D7 — The tool description points at the card, and it no longer points at the sandbox for display

The description of `alphafold_prediction` keeps its rule that the coordinates never enter the context window. It gets one sentence: to show the structure, call `show_user(kind: "structure", url)` with `pdbUrl` or `cifUrl`. The sandbox stays the path to read coordinates or the per-residue document. It is no longer the path to look at the fold.

## Risks / Trade-offs

- **The CSP of the host.** The `connect-src` of Lumen must admit `https://alphafold.ebi.ac.uk` for the file bucket and for the prediction API. No repository in the workspace defines the policy, and the edge sets it. The Lumen change lists it as a deployment prerequisite. A blocked origin shows as the load-failed state of the card, not as a broken page.
- **The rollout order.** A Cortex that is bumped before Lumen emits cards that Lumen drops. Bump Lumen first, then Cortex. The Cortex change records this.
- **The allowlist scope.** One host in this change. RCSB or PDBe is one grammar row plus one host scenario, and both answer CORS `*`. Neither is added until a tool returns their URLs.

## Migration Plan

The change adds and removes nothing. No persisted card changes its shape. Publish the harness. Lumen adopts, then Cortex. No data migration is necessary. A rollback reverts the version pins.
