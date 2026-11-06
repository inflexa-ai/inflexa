## Context

The harness change `add-gdc-data-to-an-analysis` adds the `InputAcquirer`
seam and the `download_gdc_data` tool. The kernel change with the same name
adds the `input_acquired` event. This change realizes the seam in the CLI.

These facts from the code set the design:

- `downloadToFile` (`src/lib/download.ts:185`) streams into `{dest}.part`,
  then it reads the file again for the SHA-256 hash, and then it renames the
  file (`:258-272`). It calculates no md5. It takes no caller abort signal.
  Its retry covers the first request only. A liveness watch ends a transfer
  that stops for 120 s.
- `downloadGeoSeries` (`src/modules/geo/geo.ts:466-562`) is the pattern for a
  set of files:
  - a sweep of stale staging directories
  - a sibling staging directory, `{dest}.incoming-{uuidv7}`
  - a retry on a shedding status (403, 429, or 5xx)
  - one failure aborts the set, and a `finally` removes the staging
  - a swap into the destination
  - a 32 GiB ceiling on the declared bytes (`GEO_SERIES_MAX_BYTES`, `:24`)
- `src/modules/refs/store.ts:355` runs its transfers on a `PQueue` with the
  concurrency 4.
- `addInputs(analysisId, rawPaths, cwd)` (`src/modules/analysis/analysis.ts:115-150`)
  inserts each new row, then it emits `prov.input_added` for that row. It
  returns only the new inputs. `Bus.emit` is synchronous. The recorder applies
  each event on receipt, and it flushes on `setTimeout(0)`
  (`src/modules/prov/prov.ts:137-138`, `:200-204`). Thus events that one
  synchronous span emits land in one flush.
- `manage_inputs` finds the analysis from `scopeResource(ctx.session.scope)`.
  It finds the anchor folder with `resolveAnchor`, and it requires
  `holdsInstanceLock` (`src/modules/harness/inputs_tool.ts:94-128`).
- A staged file is at `data/inputs/local/{key}`. For an anchored input, the
  key is `{input path}/{subpath}` (`src/modules/staging/staging.ts:342-348`).
  The function that makes the key is not exported.
- The bridge strips the `/{analysisId}/` prefix from a step read. Thus
  `ProvUsedInputRef.path` is `data/inputs/local/…` (`src/modules/harness/prov_bridge.ts:73-76`).
- Each flush serializes the whole document, calculates the chain hash, and
  signs it (`src/modules/prov/prov.ts:269`).
- The telemetry projection of the bus has a case for each member and no
  default case (`src/lib/bus.ts:38`).
- `prov.input_added` starts the profile ladder after 500 ms. The ladder stages
  and hashes each file, and it starts the data profile
  (`src/tui/hooks/profile_parity.ts:241-265`).

## Goals / Non-Goals

**Goals:**

- One approved call downloads a plan into the analysis folder, and adds it as
  one input.
- The provenance holds the origin of each file, and a step read joins it.
- A failure leaves no partial directory and no input.

**Non-Goals:**

- A CLI command for the GDC. The agent path is the harness tool.
- A progress display in the chat.
- A change to `inflexa geo download`.
- A refactor of `downloadGeoSeries`.

## Decisions

### The realization is an in-process module

`src/modules/harness/input_acquisition.ts` exports `createInputAcquirer`.
`runtime.ts` gives its result to the conversation agent as `inputAcquirer`.
The realization runs in the chat process, as `manage_inputs` does. Thus its
bus events reach the recorder and the profile watcher.

The realization resolves the analysis, the anchor folder, and the lock as
`manage_inputs` does. If the session has no analysis scope, or the process
does not hold the lock, it returns `refused` with the reason.

This design rejects a subprocess command, as `inflexa geo download` is. The
lock of the chat refuses a subprocess that adds an input, and a subprocess
cannot emit on the bus of the chat.

### The destination is new, in the anchor folder

The destination is `{anchor folder}/{plan.name}`. Thus the input is anchored,
and its staged path is `data/inputs/local/{plan.name}/{item path}`.

If the destination exists, the realization returns `destination_exists`. It
does not replace the directory, as GEO does. The directory can be a current
input. A replacement changes the bytes of an input with no record in the
provenance.

`maxBytes` is 32 GiB, the GEO ceiling. The realization compares the sum of
the declared sizes before it moves a byte.

### The transfer

1. Sweep the stale `{dest}.incoming-*` directories of the same name.
2. Make the staging directory `{dest}.incoming-{uuidv7}`.
3. Download the items on a `PQueue` with the concurrency 4. Each item uses
   `downloadToFile`, with the GEO retry on a shedding status.
4. Write `acquisition-receipt.json` in the staging directory.
5. Rename the staging directory to the destination.
6. In a `finally`, remove the staging directory when it still exists.

If one item fails, the realization aborts the queue, and it returns the error
of that item. The signal of the tool call aborts the queue too.

### `downloadToFile` gets an md5 and a signal

`DownloadToFileOptions` gains two optional fields:

- `expectedMd5`: the counting transform also feeds an md5 hash. At the end,
  a mismatch deletes the `.part` file and returns the new error
  `digest_mismatch`.
- `signal`: the fetch and the pipeline obey the caller signal together with
  the liveness signal (`AbortSignal.any`). An abort deletes the `.part` file
  and returns the new error `aborted`.

The md5 comes from the stream, and thus it costs no second read. The SHA-256
path does not change. The current callers pass neither field, thus their
behavior does not change.

### The receipt

`acquisition-receipt.json` holds the plan, the time of the download, and one
row for each item: the path, the bytes, and the SHA-256 hash. It is a file of
the input. It is not a row of the origin record, because the CLI made it and
the source did not.

### The input and the events are one synchronous span

`addInputs` gains an optional fourth argument:

```ts
type AddInputsOptions = {
    /** The origin of an input that a download made. Called for each inserted input. */
    acquisition?: (input: AnalysisInput) => ProvAcquisitionRef | undefined;
};
```

For each inserted input, `addInputs` emits `prov.input_acquired` when the
callback gives a ref. Then it emits `prov.input_added`. The two emits are in
one synchronous span, thus they land in one flush, in that order.

The realization makes the ref from the plan and the transfer results. Each
file row carries the staged path from a new export of `staging.ts`:

```ts
/** The analysis-relative path of one file of an input, as a step read records it. */
export function stagedInputPath(input: AnalysisInput, subpath: string): string;
```

The function gives `data/` joined with the `relativePath` that
`stageInputs` computes (`src/modules/staging/staging.ts:342-351`), and
`stageInputs` uses it. Thus the staged path and the origin path cannot drift
apart.

If `addInputs` returns no new input, or it fails, the realization deletes the
destination and returns `refused`. The destination is new, thus a duplicate
row is not an expected state.

### The bus and the recorder

`prov.input_acquired` carries the analysis id, the actor, the input ref, and
the acquisition ref. The ref types come from the kernel, through
`src/types/prov.ts`. The recorder maps the member through `toKernelEvent`
with no branch of its own.

The telemetry case gives the analysis id, the actor kind, the input path, the
source name, the release, and the file count. It gives no URL.

### The lineage render

A backward walk from a downloaded file now passes the `AcquireInput` action
and ends at the source node. The tree shows the action with the source name
and the release. It shows the source node with its identifier and its source
digest. The JSON, dot, and mermaid renders carry the source node. A staged
file with no download stays a terminal input.

## Risks / Trade-offs

- [The profile of a directory with 1,231 files] → Staging hashes each file
  again. The harness profiler lists a maximum of 1,000 unclassified paths in
  its recipe (`harness/src/tasks/data-profile-resolve.ts:49`), and it has a
  deadline of 20 minutes. The first real TCGA-BRCA download must show how the
  profile behaves. A failure there is a profiler issue, not a download issue.
- [Each later flush serializes a larger document] → The estimate is 1.2 MB
  for the TCGA-BRCA gene counts. A step that reads the same files adds a cost
  of the same order today.
- [The GDC sheds load] → The GEO retry covers 403, 429, and 5xx, and the
  queue holds 4 transfers at a time.
- [A download takes some minutes, and the chat shows no progress] → The
  realization logs a heartbeat. The chat display is a later change.
- [The user removes the input later] → The files stay in the folder, and the
  provenance records the removal, as for each other input.

## Open Questions

None.
