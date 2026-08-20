## Why

The data profile changed its format. The profiler now groups a tree into `kinds`. It
describes at most 50 individually notable files in `files`. The CLI still reads `files`
alone. Thus a tree of 2000 files in 3 kinds renders as "2 files" in the rail. The details
dialog lists the same two paths and calls that the profile.

The dialog also drops each other field that the profiler records:

- the domain and the subtype
- the organism, the tissue, the cell type, and the condition
- the accessions and the experimental design
- the axes and the coverage
- the quality assessment

The row is the only durable home of the profile. Thus what the dialog does not show, the
user cannot read anywhere in the CLI.

## What Changes

- The DATA PROFILE line of the rail reports the scanned total and the kind count, for
  example `38 files · 2 kinds · 7/8/2026, 2:00 AM`. The total comes from
  `coverage.total`, then from the sum of the kind counts, then from the described-file
  count. A row that carries no kinds keeps the two-part line that it renders today.
- The details dialog renders the whole row, in blocks: the lifecycle, the summary, the
  subject, the structure of the dataset, the described files, the quality findings, and
  the seed-input count. A block whose fields are all absent contributes no lines.
- The file list of the dialog takes the heading `described files`. The list is a
  selection that the profiler made, and the bare noun claimed a total.
- Each described file carries its own facts under its line: the data type, the format, the
  row and column counts, the tags, the metrics, and the warnings.
- An explicit null organism renders as `organism: none identified`. The contract makes
  null a finding, and absence a gap.
- The mock profile of the design gallery carries kinds, axes, coverage, a subject, and a
  quality assessment. Thus the exhibit shows what a current row renders.

## Capabilities

### New Capabilities

None. The change modifies the `sidebar-live` capability.

### Modified Capabilities

- `sidebar-live` — the count of the rail, and the content of the profile details view.

## Notes

The harness needs no change. The pinned `@inflexa-ai/harness` already publishes `kinds`,
`axes`, and `coverage` on `DataProfileResult`. The CLI reads the row that the harness
already writes.
