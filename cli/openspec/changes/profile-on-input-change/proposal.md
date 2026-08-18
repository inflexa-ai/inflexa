## Why

`ensureProfileAtParity` re-profiled whenever a freshly enumerated `(fileId, size, mtimeMs)`
set differed from the one a completed row recorded. That comparison is an inference — the
files look different, therefore the data changed — standing in for a fact this process
already holds.

It is wrong in both directions:

- **False positives cost a full run.** `size`/`mtimeMs` move on `git checkout`, `cp -r`,
  `rsync` without `-a`, unzip, restore-from-backup, and cloud sync, none of which change a
  byte. Each one fires a sandbox spin-up and an LLM agent run on chat open, unasked. And a
  re-profile is not a cache refill: the profiler is an agent, so kind names,
  `memberRepresents` phrasings, axis labels, organism inference, and the summary are all
  re-rolled — it silently rewrites the description the user has been reasoning with.
- **The failure it prevents is mild.** `DataProfileResult` records that the workspace
  filesystem is the authoritative file list and the profile deliberately is not one. A
  superseded profile degrades the opening orientation; `list_files`, `grep`, and
  `scan_inputs` still read the live tree.

Meanwhile the CLI already emits `prov.input_added` / `prov.input_removed` in-process the
moment an input set changes, and `watchProfileParity` already listens. The fact was
available on a reliable edge and the ladder was inferring it from a proxy instead.

## What Changes

- **Only a recorded input mutation re-profiles.** `reprofileForInputChange` is the new
  entry point the bus edge drives. A chat open (or analysis swap, or a run settling) brings
  the workspace tree up to date and leaves a completed profile alone.
- **`isProfiledAtParity` and `inputSetMatches` are deleted.** With them goes the
  comparand-era ladder that read `inputFiles` and treated an `inputFileIds`-only row as
  drift — a verdict that disagreed with the harness's own predicate on the same row.
- **`enumerateInputSignatures` becomes `enumerateInputPaths`.** Nothing compares per-file
  drift signatures any more, so it returns the analysis-relative path set and gathers no
  size or mtime. `inputSignature` (the `fileId:size:mtimeMs` encoder) and
  `inputSignatureDigest` (which took it apart again from the right) both go.
- **A completed row now consults the materialized predicate** instead of inferring the tree
  from parity. "The profile covered this set" could stand in for "the set is on disk" only
  while the ladder still compared sets.
- **The terminal `inflexa inputs add`/`remove` say so.** They boot no runtime and never
  did, and a later chat open no longer re-profiles on their behalf, so they name
  `inflexa profile` rather than leaving the profile silently behind.

## Impact

- Affected specs: `input-staging`, `data-profile-launch`
- Affected code: `src/modules/staging/staging.ts`, `src/modules/harness/profile_trigger.ts`,
  `src/tui/hooks/profile_parity.ts`, `src/modules/analysis/inputs_command.ts`
- Requires the harness change that deletes `isDataProfileStale` — the same decision on the
  service side of the same boundary.
- An in-place edit of an already-attached file is no longer detected. It changes no path, so it
  raises no input event, and nothing else looks. `forceReprofile` is the repair, and provenance
  is unaffected: `appendInputUsed` records `(path, hash)` with the hash read from disk at step
  reconcile time, so every artifact still names the bytes it actually consumed.
