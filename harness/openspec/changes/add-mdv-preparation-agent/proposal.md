# Add an agent that prepares MDV assets

## Why

MDV (Multi-Dimensional Viewer) is a web viewer for single-cell and spatial data. It loads an AnnData through its upload, and it makes a table of cells and a table of genes from it. Today no agent and no skill in the roster knows MDV. Thus a request to prepare a dataset for MDV goes to the nearest modality agent, or to the executor, with no guidance.

The upload has traps that do not show as errors before the load. A pandas type that the conversion does not map stops the upload. A duplicate cell name changes the row count. A text column that pandas 3 writes as a nullable string array stops the upload. A column label is the name that a person sees, thus a raw key or a bare cluster id is what the person reads. A raw CosMx run has no documented sign between the axes of a field of view (FOV) and the axes of the stage, and a wrong sign scrambles the tissue.

A person needs an asset that loads, that is correct, and that a different person can read. Thus the work needs one workflow, one set of rules, and one validator.

## What Changes

- A new plannable sandbox agent, `mdv-preparation-agent`. It takes scRNA-seq, snRNA-seq, scATAC-seq, multiome, spatial transcriptomics, and spatial proteomics data. It delivers an MDV-ready AnnData, the context tables, a README, the report of the validator, and the analysis AnnData.
- A new skill pack, `mdv-preparation`. It holds the workflow, the contract of an MDV-ready asset, the code of the helper modules, the validator, and one reference for each modality. The CosMx reference includes a reader for the raw instrument output and a measurement of the FOV orientation.
- The agent declares the new pack and the packs `single-cell`, `spatial-omics`, `chromatin-regulation`, and `shared/omics-general`.
- The agent needs no new package: the asset is an AnnData, and MDV makes the project from it.

## Capabilities

### New Capabilities

- `mdv-preparation-agent`: the definition, the composition, the skills, and the tools of the agent.
- `mdv-preparation-skill`: the anatomy of the pack, its workflow, its asset contract, and its validator.

### Modified Capabilities

- `agent-roster`: the roster has 22 agents, and 20 of them are plannable.
- `agent-skill-assignment`: the inventory has 21 packs, and 20 of them are agent-specific.

## Impact

- `harness/src/agents/sandbox/mdv-preparation-agent.ts` and `harness/src/prompts/sandbox/mdv-preparation-agent.ts` are new.
- `harness/src/agents/sandbox/index.ts` registers the agent. `harness/src/agents/sandbox/test/catalog.test.ts` counts 22 agents.
- `skills/mdv-preparation/` is new, and `skills/README.md` lists it.
- No change to the package store.
