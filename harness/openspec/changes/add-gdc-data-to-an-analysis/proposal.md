# Add GDC data to an analysis

## Why

An analysis can use only the data that the user adds. The sandbox has no
network, and no tool brings public data into an analysis. In one analysis, a
step reported that the survival data was absent. The NCI Genomic Data Commons
(GDC) gives that data for TCGA, but the agent had no method to get it.

The GDC holds 93 projects in 27 programs (Data Release 46.0). Thus one
capability gives TCGA, TARGET, and the other programs. The download occurs in
the conversation, with the approval of the user. A step cannot ask for
approval, and the inputs are the contract of an analysis.

## What Changes

- A GDC client in `src/tools/lib/` sends the queries to the GDC API. A zod
  schema validates each response, as `bio-api-schema-fidelity` specifies.
- The new `search_gdc_data` tool gives GDC metadata to the agent. It gives the
  projects, and the case and file counts for each data category, data type,
  workflow type, sample type, and access level. It downloads no data.
- A plan builder changes a GDC request into a download plan. The request names
  a project, a data type, a workflow type, and the sample types. The plan holds
  the GDC release, the filter, and one row for each file:
  - the UUID, the name, the size, the md5, and the URL
  - the case barcode, the sample barcode, and the sample type
- Only open-access files go into a plan. A plan can also hold the clinical
  records of the cases. GDC gives no md5 for these records.
- The new `download_gdc_data` tool makes the plan. Then it asks the user for
  approval, with the file count and the total size. Then it gives the plan to
  the new input-acquisition seam.
- The embedder realizes the new input-acquisition seam. The embedder downloads
  each file of a plan, and it makes sure that each md5 agrees. Then it writes
  the plan beside the files, adds the files as one input, and records the
  origin.
  - The plan names its source. GDC is the first source, but the seam is not
    specific to GDC.
  - The seam is optional. If the embedder gives no seam, the conversation agent
    does not get `download_gdc_data`.
  - The harness emits no provenance event for the download. The embedder
    records the download, because the embedder adds the input.
- The conversation agent and the planner get `search_gdc_data`. Thus a plan can
  name a GDC source for data that the inputs do not hold.
- The download writes each file as GDC gives it. The tool does not merge the
  files into a matrix, and it does not calculate survival. A sandbox step does
  that work, and the provenance records the code of that step.

These items are not in this change:

- Controlled-access data. A dbGaP token is necessary for that data.
- A download from a step agent.
- The provenance of `inflexa geo download`.
- The skill content for the TCGA survival endpoints.

## Capabilities

### New Capabilities

- `gdc-tools`: the GDC client, the `search_gdc_data` tool, the plan builder,
  and the `download_gdc_data` tool.
- `input-acquisition`: the download plan and the optional embedder seam. The
  seam downloads a plan, adds it as an input, and records its origin.

### Modified Capabilities

None.

## Impact

- `src/tools/lib/`: the new GDC client, with golden fixtures of real GDC
  responses.
- `src/tools/bio/`: the new `search_gdc_data` tool and the new
  `download_gdc_data` tool.
- `src/agents/conversation-agent.ts`: the optional seam in
  `ConversationAgentDeps`, and the two tools in the roster.
- `src/tools/research/generate-plan.ts`: `search_gdc_data` in the tools of the
  planner.
- `src/index.ts`: the seam type and the plan type go into the root barrel,
  because the embedder writes the seam.
- The CLI change `add-gdc-data-to-an-analysis` realizes the seam. The
  prov-kernel change with the same name gives the `input_acquired` event.
- The harness does not use the kernel event. Thus the harness and the kernel
  can publish in any sequence, and the CLI release comes after the two.
- The external API is `https://api.gdc.cancer.gov`. An API key is not
  necessary for open-access data.
