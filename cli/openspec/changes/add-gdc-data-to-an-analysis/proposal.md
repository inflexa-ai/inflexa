# Download GDC data into an analysis, and record its origin

## Why

The harness gives a `download_gdc_data` tool and an input-acquisition seam. The
CLI must realize that seam, because the CLI owns the analysis folder, the
inputs, and the provenance recorder.

The `inflexa geo download` command records no provenance, and it adds no input.
A GDC download must do the two tasks in one operation. Thus no gap occurs
between the download and the input, and the bytes cannot change between them
with no record.

## What Changes

- The CLI realizes the harness input-acquisition seam in the process of the
  chat, as `manage_inputs` does. Thus its events reach the recorder and the
  profile-parity watcher.
- The realization downloads each file of the plan into one directory in the
  analysis folder. It uses the current downloader in `src/lib/download.ts`,
  which writes a `.part` file and then renames it.
- It makes sure that the md5 of each file agrees with the md5 of the plan. It
  also calculates the sha256 of each file.
- If a digest does not agree, the download fails, and the CLI adds no input.
- It writes the plan and the calculated digests as a JSON receipt beside the
  data files.
- It adds the directory as one input through `addInputs`. It emits
  `prov.input_acquired`, and then `prov.input_added`.
- The `prov.input_acquired` event carries the staged path of each file. The
  kernel file QName derives from the analysis-relative path and the hash. Thus
  the event must use the path that a step reads.
- The recorder maps `prov.input_acquired` onto the kernel `input_acquired`
  event.
- The download has a size ceiling, as `inflexa geo download` has.
- `runtime.ts` gives the seam to the conversation agent.

## Capabilities

### New Capabilities

- `input-acquisition`: the in-process realization of the harness seam. It
  covers the download, the digest comparison, the receipt, the input, and the
  events.

### Modified Capabilities

- `analysis-input-management`: the input-acquisition realization becomes one
  more surface that adds an input through `addInputs`.
- `prov-run-events`: the bus contract gains `prov.input_acquired`, and the
  recorder maps it through the kernel.
- `prov-lineage`: a backward walk from a downloaded file shows the download
  and the source item, not a terminal input.

## Impact

- `src/modules/harness/`: the new seam realization, beside `inputs_tool.ts`.
- `src/modules/harness/runtime.ts`: the seam in the deps of the conversation
  agent.
- `src/types/events.ts` and `src/lib/bus.ts`: the new bus member.
- `src/modules/prov/prov.ts`: the map from the bus event to the kernel event.
- `src/modules/prov/lineage.ts`: the render of the source node.
- `src/lib/download.ts`: an md5 comparison and an abort signal.
- `src/modules/staging/staging.ts`: an exported function for the staged path
  of a file.
- The change uses the harness seam and the kernel event of the changes with
  the same name.
- A TCGA-BRCA download of the gene counts is 5.2 GB in 1,231 files.
