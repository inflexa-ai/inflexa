## Why

The data profile is an orientation record — it tells planning what a dataset *is*. It
is not quality control; analysis steps do that. Today it behaves as per-file QC, and at
scale that fails in three independent ways at once.

Measured on a production analysis of 3513 per-patient VCFs (39.5 min wall, 87 LLM calls):

- **The agent is the loop.** `data-profiler` runs one programmatic pass per input file
  (head/wc → Python script → read-back), so cost scales with file count. Its
  `defaultMaxSteps: 85` covers ~28 files at that rate. It spent its entire budget and
  described **49 of 3513 files** (`fallbackCount: 3464`); the remainder got deterministic
  fallback text.
- **The output contract is unsatisfiable.** `ProfilerOutputSchema.files` is an unbounded
  array and the prompt demands metadata for EVERY file. At ~100 tokens per entry, 3513
  files is ~350k output tokens against a 64k ceiling. No deadline or step budget makes
  this reachable.
- **Indexing is serial.** 3513 sequential `embed([oneText])` + `upsert` round trips —
  12.1 min of the 39.5, ~96% of it embedding latency. Both interfaces already take
  arrays; the loop passes arrays of one.

The work is also aimed at the wrong target. The profile's primary consumer, the planner,
reads `buildDataProfileOrientation` clamped to **1200 characters and 8 files**, and has no
`inspect_data_profile` tool. `inspect_data_profile` pages per-file records at 20 (max 100).
Nobody reads 3513 per-file descriptions — the per-file arm is almost entirely write-only
data, generated at LLM prices.

Finally, the failure is invisible. `isDataProfileStale` compares seeded ids against profiled
ids; both were 3513, so a profile covering 1.4% of its inputs reads as **completed and
fresh**, and nothing will re-trigger it.

## What Changes

- **A deterministic input scan replaces per-file agent work.** One sandbox exec walks the
  staged tree and returns a structured manifest: per file path/size/format (magic bytes)
  and decoded headers; filename tokenisation yielding *kinds* (what a file is) and *axes*
  (what varies across files) with cardinalities, example values, entity key sets, and an
  unmatched bucket. The manifest is injected into the profiler's briefing in the slot that
  currently inlines every path (~270 KB → ~2 KB), and is also exposed as a `scan_inputs`
  tool taking a path so the agent can re-scan a subtree.
- **Two-axis output.** `ProfilerOutputSchema` gains `kinds` and `axes`, both capped. A kind
  is a repeating set with a count and a path pattern; an axis is a varying filename position
  the agent labels ("patient", "timepoint"). Singletons are kinds of count 1, so there is
  one concept, not two. The cap makes the contract satisfiable by construction — a model that
  enumerates members hits a validation error instead of silently truncating. Nothing biological
  is encoded: kind and axis are structural, their labels open vocabulary.
- **`files[]` becomes notable singletons only** — the metadata sheet, README, paper, outliers —
  with genuine prose, because there are few. The workspace filesystem is already the
  authoritative file list; `list_files`, `grep`, and the vector index all read the live tree,
  so copying every path into JSONB stored a stale duplicate. Shape is unchanged, only the
  population policy, so every existing reader keeps working.
- **Indexing becomes tiered and batched.** One vector per kind (`type: "input-kind"`, new)
  answering *kind* queries, one per entity (`type: "input"`, unchanged) answering *entity*
  queries, none per file. Entries are templated deterministically from the kind's description
  and the entity's axis values — zero LLM tokens — and embedded in batches of ~256.
- **The input comparand becomes a digest.** `inputSignature: { count, digest }` replaces the
  3513-element `inputFileIds` / `inputFiles` arrays as the staleness comparand. Coverage joins
  the predicate: a profile whose files mostly fall in the unmatched bucket is detectably poor
  rather than silently fresh.
- **Prompt rewrite** under one rule — *keep the checks that answer "what is this", cut the ones
  that answer "is this good"*. States the purpose (orientation, not QC); consumes the manifest;
  keeps Stage 1 identity work; adds naming kinds and axes; adds an explicit Do-NOT section; and
  deletes the per-format QC checklists (Ti/Tv, allele-frequency spectra, replicate correlation,
  PCA outlier detection, coverage depth, mapping rate, duplicate rate, insert size, GC bias).
  `defaultMaxSteps` drops from 85 to ~30.
- **`DEFAULT_DEADLINE_MS` is raised.** It is an absolute whole-profile budget captured after
  `createSandbox`; at 5 minutes the new scan pass would exhaust it before the agent starts.

**No BREAKING changes.** `data_profile_result` has no parse at the read boundary — the jsonb
column is cast straight to the interface, and optionality *is* the documented compatibility
mechanism. `kinds`, `axes`, and `inputSignature` are additive optionals; `inputFileIds` moves
from required to optional (old rows always carry it, and TypeScript catches unguarded reads);
`files[]` keeps its shape. Readers branch on presence, mirroring the legacy-snapshot branch
`buildDataProfileOrientation` already carries. No migration, no backfill.

## Capabilities

### New Capabilities

- `input-scan-manifest`: The deterministic pre-agent scan of a staged input tree — file
  enumeration, magic-byte format detection, header decode, filename tokenisation into kinds and
  axes, entity enumeration and cross-kind key-set overlap, completeness counting, and the
  unmatched bucket. Defines the manifest contract, its injection into the profiler briefing, and
  the `scan_inputs` tool. Groups are a *proposal* the agent may split, merge, or relabel; an
  over-confident cross-kind join is a defect.

### Modified Capabilities

- `data-profile-init`: Profiler output gains capped `kinds`/`axes` and narrows `files[]` to
  notable singletons ("The data-profiler agent delivers results through a terminal submit_profile
  tool", "The snapshot is the profiler's full output, not a summary of it"). Indexing becomes
  tiered and batched ("Profile outputs are registered, indexed, and snapshotted").
  `inspect_data_profile` gains a `kinds` scope and reports dataset totals distinctly from the
  described-file count ("The profile is readable only through inspect_data_profile").
- `data-profile-rerun`: The result snapshot carries a digest comparand rather than the full
  profiled id list, and coverage joins staleness ("Result snapshot carries the profiled input
  set").
- `data-profile-observation`: The scan is a reported phase, so a consumer sees the longest
  pre-agent operation rather than silence ("The profile reports activity across its whole
  duration, not only its agent loop").
- `sandbox-format-standards`: The profiler orients from the injected manifest rather than
  workspace listing ("Data-profiler orients via workspace tools, not cd and ls").

## Impact

**Harness** — `tasks/data-profile.ts` (scan call, briefing assembly, batched tiered indexing,
deadline), `schemas/data-profile-schemas.ts` (`kinds`/`axes`, caps), `state/data-profile.ts`
(result widening, `inputSignature`, optional `inputFileIds`), `app/data-profile-orientation.ts`
(render kinds first, legacy fallback), `app/data-profile-policy.ts` (digest + coverage
staleness), `tools/research/inspect-data-profile.ts` (`kinds` scope, honest totals),
`prompts/sandbox/data-profiler.ts` (rewrite), `agents/sandbox/data-profiler.ts` (roster,
`defaultMaxSteps`), plus the new scan tool and its sandbox-side script.

**Out of scope, unrelated** — the sandbox reaper owner-workflow-id label round-trip and the
provenance socket `sun_path` overflow are real defects tracked separately. Neither gates this
change: the reaper reaps on a ten-minute creation grace that the 25-minute profile which exposed
it reached and a profile finishing in minutes does not.

**Cortex host, separate change** — `managed/http/analyses.ts` re-derives the staleness predicate
with `.includes()` inside `.some()` (O(n²); ~12.3M comparisons per GET at 3513 files) instead of
calling `isDataProfileStale`, and ships `files` unpaged to Lumen. Both need fixing; the response
shape change needs a Lumen-side check.
