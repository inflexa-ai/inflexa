# Design — display realization (harness side)

## Rename now, before renderers exist

`data-preview` is the only part in the vocabulary named after a mechanism
rather than its content, and it is report-specific in reality: emitted only by
`iterate_report`, backed by the `PreviewPublisher` seam, living under
`previews/` in the workspace. The CLI is about to grow a renderer for it —
renaming first means the renderer is born against the final name and no
consumer ever handles both.

The rename is a pair: `data-preview-failed` rides along as
`data-report-preview-failed`.

Why this is cheap: cards are never persisted. The turn stores only the
Anthropic transcript (text / tool_use / tool_result); `reconstruct-cards`
re-derives each card from the `iterate_report` tool_use block via the shared
card-builders. Reconstruction keys on the *tool name*, not a stored part type,
so historical transcripts reconstruct under the new name with no migration.
The blast radius is code-level (contracts, schemas, registry, two emit sites,
two reconstruction modules) plus external consumers of the contracts barrel
(react-client), for whom this is **BREAKING**.

## Artifact-sourced charts: extend `show_user`, not a new tool

The use case: the agent should chart data that already exists as an artifact
(a chart-ready CSV a sandbox step wrote to `figures/` or `output/`) without
pulling the rows through its context window and inlining them into the spec
JSON. Fine for a 20-row aggregate, hostile for anything real.

Considered and discarded: a separate `show_chart` tool. It would duplicate the
entire presentation pipeline (card building, deterministic ids, emit,
reconstruction) for one variation, and `show_user`'s deliberately flat schema
(Anthropic rejects top-level unions) makes an optional field the natural
extension point. So: `dataPath?: string` on the `echart` kind.

The contract split follows the reference-not-bytes philosophy the display
cards already enforce (`show_file` resolves paths at render time;
`data-report-preview` resolves URLs at render time via `content-url.ts`):

- **Agent side** — the spec uses ECharts' native `dataset`/`encode` mechanism:
  dimensions and encodings written against *column names*, `dataset.source`
  omitted. The agent only ever needs to read the CSV header to author the
  chart, not the data.
- **Host side** — at render time the host loads the artifact and injects it as
  `dataset.source`. The web UI fetches via the artifact service; the CLI reads
  the workspace file; a future local webserver serves it as a fetch. Each host
  realizes loading its own way; the contract stays host-agnostic.

### CSV conventions are pinned minimal

RFC-4180 CSV with a required header row; hosts infer numeric columns. Anything
fancier (delimiters, typed schemas, transforms, aggregation) is the sandbox's
job — an analysis step pre-shapes a chart-ready CSV. This keeps every host's
parser trivial and puts data preparation where the compute already is.

### No existence check at emit time

`show_user` validates `dataPath` *shape* only (the `show_file` rules:
analysis-rooted, no leading slash, no `..`, no NUL, length-capped) and returns
the same `{ shown: false, reason: "invalid_path" }` data variant on failure.
It does not check the file exists — consistent with `show_file`, which also
emits unverified references. A missing or unparseable artifact at render time
is a host concern: the card renders degraded, never crashes (the CLI side
already has this as house law for workspace desync).

### Deterministic ids still hold

`presentationId` hashes the full input object, so `dataPath` participates in
the id automatically — an identical re-emission resolves to the same card, and
a host cache keyed by the id stays correct.

## Explicitly out of scope

- The agent is NOT told about the host's rendering medium (no prompt
  conditioning on CLI vs web). A per-host tool interface was discussed and
  parked as a separate future question.
- Inline-data `echart` specs remain fully legal — `dataPath` is additive, for
  the case where the data already exists as an artifact.
- The CLI-side realization (materialization, open UX) lives in the companion
  CLI change, not here.
