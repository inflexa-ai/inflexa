## Why

Re-profiling is decided twice: once by the party that changed the input set, and again
by whoever next reads the ledger row. The second decision is the problem — it is made
from strictly less information than the first, and it is the one that fires.

**The reader cannot see what it claims to judge.** `isDataProfileStale` compares a
"current input set" against the profile's recorded comparand, and neither embedder can
supply a current set worth comparing:

- The managed service holds `seed_input_file_ids` — ids Cortex itself wrote at the last
  seed. Comparing them against a profile derived from that same seed is self-referential:
  it can only ever catch a disagreement between two of Cortex's own writes, never a
  divergence from the authority (Nexus). It passes no `signature`, so the predicate takes
  its degraded branch and compares counts alone.
- Nothing else is available to it. Nexus's stored `size`, `etag`, and `updated_at` are
  last-scan snapshots of storage the platform does not own; for an external mount they all
  fail in the same direction — unchanged when it changed. A confident wrong answer, not a
  miss.

**The writer already knows, at the moment it happens.** Nexus's `AddAnalysisInputs`
refuses the mutation while profiling is in flight, commits the input rows and the reprofile
job in one transaction, and River retries it — `AnalysisSeedArgs` documents itself as "the
initial seed at create time and every subsequent reprofile triggered by an input change."
The CLI emits `prov.input_added` / `prov.input_removed` in-process on the same edge. Both
embedders hold the event; only one of them acts on it.

**And the read-path decision is expensive when wrong.** A re-profile is not a cache
refill. The profiler is an LLM agent, so kind names, `memberRepresents` phrasings, axis
labels, organism inference, and the summary are all re-rolled — a re-profile silently
rewrites the description a user has been reasoning with. The comparand's size/mtime half
fires on `git checkout`, `cp -r`, `rsync` without `-a`, unzip, restore-from-backup, and
cloud sync, none of which change a byte. Meanwhile the failure it prevents is mild:
`DataProfileResult` says outright that the workspace filesystem is the authoritative file
list and the profile deliberately is not one, so a superseded profile degrades the opening
orientation while `list_files`, `grep`, and `scan_inputs` still read the live tree.

## What Changes

- **Re-profiling becomes push-only.** The embedder that owns the input mutation invokes it,
  at the moment of the mutation. No consumer derives a re-profile decision by reading a row.
- **`app/data-profile-policy.ts` is deleted** — `isDataProfileStale`, `decideDataProfileAction`,
  and their input types. It had two harness callers and one embedder caller, all of which
  were re-deciding a question already answered upstream.
- **`inspect_data_profile` and `generate_plan` stop deriving a staleness verdict.** Both keep
  the qualifications the row states outright — a re-profile in flight over a prior result, or
  a failed attempt over one — and drop the one they were inferring.
- **The audit record stays.** `inputSignature` is still written by the profile body: forty
  bytes computed once that record what a profile covered. Deleting the readers costs nothing;
  deleting the record would make "what did this profile cover?" permanently unanswerable.

## Impact

- Affected specs: `data-profile-rerun`, `data-profile-init`
- Affected code: `src/app/data-profile-policy.ts` (deleted), `src/tools/research/inspect-data-profile.ts`,
  `src/tools/research/generate-plan.ts`
- Embedders: the CLI drops its parallel `isProfiledAtParity` and re-profiles on its input-mutation
  edge; the managed service drops the re-trigger from its chat-context GET, which also removes the
  route's ability to mutate at all.
- In-place edits to an already-attached file are no longer detected anywhere. That is accepted:
  provenance records the content hash of what each step actually read (`fillInputHashesFromDisk`),
  so lineage stays true regardless of what the profile says. A deliberate re-profile remains the
  repair path, and the managed service will want its own route for it.
