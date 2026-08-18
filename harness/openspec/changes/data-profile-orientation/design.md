## Context

The data profile characterises an analysis's input tree so planning has real dataset facts.
Today the `data-profiler` agent does that file by file — its own comment states the strategy:
"Profiling fans out one programmatic pass per input file (head/wc preview + a Python script +
read-back)". Cost therefore scales with file count while the step budget does not, and the
output contract asks for per-file metadata without a bound.

Two facts constrain the redesign more than anything else:

- **The consumers are tiny.** The planner reads a 1200-character, 8-file projection and has no
  `inspect_data_profile` tool. The conversation agent's per-file scope pages at 20 (max 100).
  Nothing reads thousands of per-file records.
- **The persisted result has no parse at the read boundary.** `state/data-profile.ts` documents
  it: the jsonb column is cast straight to `DataProfileResult`, so "optionality *is* the
  compatibility mechanism". Widening is free; narrowing a required field is not.

## Goals / Non-Goals

**Goals:**

- Profile cost independent of input file count.
- An output contract satisfiable for any input size, enforced by the schema rather than the prompt.
- A description of the dataset's *shape* — what kinds of files exist, what varies across them —
  rather than a list of files.
- Full backwards compatibility with existing `data_profile_result` rows: no migration, no backfill.
- Coverage failures visible instead of reading as a fresh, complete profile.

**Non-Goals:**

- Quality control. Ti/Tv, allele-frequency spectra, replicate correlation, PCA outlier detection,
  coverage depth, mapping rate, duplicate rate, insert size, GC bias — all removed. Analysis steps
  own QC.
- Removing the sandbox from the profile path. The agent keeps its full toolset.
- The sandbox reaper owner-label round-trip and the provenance socket `sun_path` overflow. Both are
  prerequisites for a profile whose sandbox outlives 10 minutes and both are in progress on
  `fix/sandbox-owner-annotation-provenance-socket`.
- Cortex host changes (`managed/http/analyses.ts`). Separate repo, separate change.

## Decisions

### Two axes — kind × entity — not one grouping dimension

A dataset is a matrix, not a list of piles: `kind` (what a file *is*) crossed with `entity` (what
it is *about*), with files as cells. A single grouping axis would emit "1171 per-patient VCFs" and
"1171 per-patient indexes" as unrelated groups, duplicating the entity axis once per kind and
losing the fact that they pair up.

Two axes buy two things that a single axis cannot:

- **Completeness becomes a counting problem.** 1171 VCFs against 1168 indexes names three subjects
  missing a file. That is QC worth having — it costs a `count()` and it changes the plan — as
  opposed to Ti/Tv, which costs a full decompress and changes nothing.
- **The axes are the experimental design.** `PT001_D0_rep1.fastq.gz` tokenises to three varying
  positions with cardinalities 1171 × 3 × 2 — subject × timepoint × replicate, derived from
  filenames. `experimentalDesign` currently requires the agent to infer this by reading files.

*Alternative considered:* a flat `groups` array (one grouping axis). Rejected as above.

### Kind and axis are structural; their labels are open vocabulary

Naming the concept `cohort` would bake in one dataset shape — a patient cohort is one input
pattern among many, and the platform also sees single matrices, per-sample FASTQ pairs, sharded
parquet, imaging fields. The domain-agnostic invariant is *repeating set vs. singleton*, which is
detectable from names and bytes with no domain knowledge. The scanner reports "position 1 varies
across 1171 distinct values"; the agent supplies "patient". No enum, free-text `label`.

A singleton is a repeating set of size 1, so there is one concept with a `count`, not two concepts
with a threshold between them. A two-file RNA-seq analysis is two kinds of count 1; degenerate
cases need no special casing.

### The cardinality rule: the LLM authors O(kinds), nothing more

| Dimension | Range | Producer |
|-|-|-|
| Kinds | 2–20, bounded by distinct (format × role) | Agent (prose) |
| Axes | 0–4 | Deterministic; agent labels |
| Entities per axis | 1 – 100k | Deterministic only |
| Cells (files) | = file count | Deterministic only |

Stated as an invariant the implementation can be checked against: **if a schema field can grow with
the number of subjects, an LLM must not be authoring it.** The `.max()` caps on `kinds` and `files`
are what make this enforceable — a model that enumerates members hits a validation error and is told
to group, so the contract teaches the behaviour instead of the prompt requesting it.

### The scan runs in the sandbox

An earlier draft split the scan into a host-side tier (walk, stat, magic bytes — bounded reads, no
decoding) and a sandbox tier (header decode). That split existed for exactly one reason: decoding
untrusted, user-uploaded bytes — gzip, HDF5, PDF — inside the long-lived multi-tenant Cortex pod is
an attack surface, and a parser CVE there is far worse than in an ephemeral sandbox.

Keeping the sandbox removes the reason for the split, so the design gets simpler rather than more
complex: **one pass at full fidelity** — walk, stat, magic bytes, *and* header decode — in a single
deterministic exec. The agent also keeps its full toolset and can drill into anything the scan
missed.

The cost accepted: sandbox provisioning (~2 min) stays on the profile path, and the profile remains
exposed to the reaper and deadline bugs until those land separately.

### The manifest is both injected and exposed

The workflow runs the scan once before the agent loop and places the manifest in the briefing, in
the slot that currently inlines every path — ~270 KB of bare paths becomes ~2 KB of structure, and
it costs zero LLM turns because the scan is always needed. `scan_inputs` is *also* a tool taking a
`path`, so the agent can re-scan a subtree. Injection is the fast path; the tool is the flexibility.

### `files[]` holds notable singletons, not every file

*Alternative considered:* keep all files in `files[]` with deterministically templated descriptions.
Rejected — the workspace filesystem is already the authoritative file list (`list_files`, `grep`,
and the vector index all read the live tree), so this stores a stale duplicate of something that
cannot go wrong, and it puts ~420 KB of JSONB on a row that `loadDataProfileStatus` detoasts on
every read, including the `generatePlan` path that needs 1200 characters of it.

So `files[]` becomes what it is good at: the handful of files that deserve prose — the metadata
sheet, README, paper, outliers. Real agent-written descriptions, because there are few. The *shape*
is unchanged, only the population policy, which is what keeps the change additive.

Consequence to handle: `inspect_data_profile scope:'files'` returning 8 for a 3513-file analysis is
misleading unless stated. It already reports `total`/`hasMore`; extend that to distinguish
"individually described files" from "files in the dataset" and point at `scope:'kinds'` plus
`list_files`.

### Index both tiers, because they answer different queries

| Query | Needs |
|-|-|
| "variant calls" (*kind*) | One hit carrying the count and the path pattern. Per-entity indexing returns 5 arbitrary subjects out of 3513 indistinguishable ones. |
| "PT0421" (*entity*) | The entity tier. |

So both, and no per-file tier — a file is `(kind, entity)` and its path is on disk. Entity entries
are not near-duplicates once they describe a *subject* carrying its axis values (and, as a stretch,
attributes joined from a metadata sheet whose column values match the entity key set) rather than a
file. Both tiers are templated deterministically from the kind's agent-written description, so
neither costs LLM tokens; batched at ~256 per embed request, ~1181 vectors is seconds.

Entity entries keep `type: "input"` and kinds take a new `"input-kind"`. Additive in the safe
direction: every existing filter keeps working on new analyses, and a new kind-filtered search
returns empty on old ones, which is honest. Renaming `"input"` would have silently broken existing
search on every new analysis.

### Compatibility is optionality, not versioning

`kinds`, `axes`, `inputSignature` are additive optionals. `inputFileIds` moves required → optional:
safe in the old-data direction because old rows always carry it, and TypeScript catches unguarded
reads at compile time. Readers branch on presence, mirroring the legacy-snapshot branch
`buildDataProfileOrientation` already carries ("A legacy snapshot has no structured identity at
all; the summary is the only orientation it carries").

`inputFileIds` earns replacement because tracing every reader found exactly one role — the staleness
comparand, at `generate-plan.ts`, `inspect-data-profile.ts`, and Cortex's `analyses.ts`. The "audit
record (WHICH files)" framing in its docstring is aspirational; nothing reads it as one. A
`{ count, digest }` signature serves the only real use in 40 bytes instead of ~133 KB.

## Risks / Trade-offs

- **Over-grouping merges things that differ in meaning** (`tumor`/`normal` read as one entity axis
  rather than two arms) → the scan returns the *distinct values* of each varying token (capped ~20)
  alongside the cardinality, so the agent can see whether the value set looks like ids or labels;
  the manifest is explicitly a proposal the agent may split, merge, or relabel.
- **Cross-kind entity matching is heuristic** (`PT001_variants.vcf` vs `PT001.tbi`) → report per-kind
  entity key sets and their overlap with the evidence; never silently merge. Non-overlapping keys are
  reported as separate axes. An over-confident join is worse than no join.
- **Unmatched files could explode into N kinds of one** (a dump of arbitrarily named files) → an
  explicit `unmatched` bucket carrying a count and a sample, and the `kinds` cap forces it.
- **Coverage in the staleness predicate could re-profile forever** on a dataset that legitimately
  resists classification → coverage must not drive unbounded auto-retrigger; see Open Questions.
- **Scan cost at very large n.** Decoding headers for 100k files is not free → the scan reports
  truncation rather than silently sampling, and the deadline is raised.
- **Provisioning stays on the profile path** by keeping the sandbox → accepted; the alternative
  traded it for parsing untrusted bytes in the Cortex pod.

## Migration Plan

No data migration and no backfill: existing rows stay valid and render through the legacy branch.
An existing profile is not invalidated by this change — including poor ones like the 49/3513 case,
which needs an explicit re-profile because it reads as fresh under today's predicate.

Deploy order: the reaper/provenance prerequisites land first, then a harness release, then Cortex
bumps the dependency. The Cortex-side `analyses.ts` fixes and the Lumen check for the capped `files`
response follow independently.

## Open Questions

1. **Cap values** for `kinds`, `axes`, and `files`. Starting points ~30 / ~8 / ~50; the `files` cap
   must exceed what legacy rows carry only in the write path, since reads are uncapped.
2. **Where the scan script lives.** Baking it into `sandbox-base` puts it on a manual, per-environment
   image release path (`sandbox.image.tag`); writing it to the sandbox at exec time ships on the normal
   harness path. Leaning write-at-exec for that reason alone.
3. **Does coverage auto-retrigger, or only surface?** Surfacing it on `inspect_data_profile` and the
   ledger is unambiguously right; making it drive `decideDataProfileAction` risks a loop and needs a
   bound before it can.
