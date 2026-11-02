# Add an agent that prepares MDV projects

## Why

MDV (Multi-Dimensional Viewer) is a web viewer for single-cell and spatial data. A person must give it a project folder that the `mdvtools` package writes. Today no agent and no skill in the roster knows MDV. Thus a request to prepare a dataset for MDV goes to the nearest modality agent, or to the executor, with no guidance.

The conversion has traps that do not show as errors. The browser logs a bad configuration and opens the project. A duplicate cell name changes the row count. A category list that is not complete codes a value as a different category. A raw CosMx run has no documented sign between the axes of a field of view (FOV) and the axes of the stage, and a wrong sign scrambles the tissue. The default output of the converter opens on an empty view, and with no edit permission it opens view-only.

A person needs a project that loads, that is correct, and that a different person can read. Thus the work needs one workflow, one set of rules, and one validator.

## What Changes

- A new plannable sandbox agent, `mdv-preparation-agent`. It takes scRNA-seq, snRNA-seq, scATAC-seq, multiome, spatial transcriptomics, and spatial proteomics data. It delivers a curated MDV project, the report of the validator, and the curated AnnData.
- A new skill pack, `mdv-preparation`. It holds the workflow, the project contract, the code of the helper modules, the view recipes, the validator, and one reference for each modality. The CosMx reference includes a reader for the raw instrument output and a measurement of the FOV orientation.
- The agent declares the new pack and the packs `single-cell`, `spatial-omics`, `chromatin-regulation`, and `shared/omics-general`.

## Capabilities

### New Capabilities

- `mdv-preparation-agent`: the definition, the composition, the skills, and the tools of the agent.
- `mdv-preparation-skill`: the anatomy of the pack, its workflow, its contract, and its validator.

### Modified Capabilities

- `agent-roster`: the roster has 22 agents, and 20 of them are plannable.
- `agent-skill-assignment`: the inventory has 21 packs, and 20 of them are agent-specific.

## Impact

- `harness/src/agents/sandbox/mdv-preparation-agent.ts` and `harness/src/prompts/sandbox/mdv-preparation-agent.ts` are new.
- `harness/src/agents/sandbox/index.ts` registers the agent. `harness/src/agents/sandbox/test/catalog.test.ts` counts 22 agents.
- `skills/mdv-preparation/` is new, and `skills/README.md` lists it.
- The agent needs `mdvtools` in the package store. The package store does not hold it, and its exact pins conflict with the catalog. Refer to `design.md`. Until the store holds it, the agent stops after the curated AnnData and reports the gap.
