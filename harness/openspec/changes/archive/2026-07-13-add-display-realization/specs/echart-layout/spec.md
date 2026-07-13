# echart-layout — delta

## ADDED Requirements

### Requirement: Artifact-sourced data goes through dataPath, not inline rows

The agent SHALL chart data that already exists as a chart-ready artifact (e.g.
a CSV a sandbox step wrote) by referencing it via `show_user`'s `dataPath`
param instead of reading the file and inlining its rows into the spec. The
spec SHALL omit `dataset.source` and author `encode` and dimension references
against the artifact's column names (read from the CSV header — the agent
never needs the data rows). Inline data remains appropriate only for small,
just-computed values that exist nowhere as an artifact. When the raw data is
not chart-ready (needs aggregation, filtering, reshaping), the preparation
belongs in a sandbox step that writes a chart-ready CSV — not in the spec and
not in the agent's context window.

#### Scenario: Charting a step output

- **GIVEN** a run step wrote `runs/run-abc/step-2/output/de-summary.csv` with header `gene,log2FC,padj`
- **WHEN** the agent charts it
- **THEN** the agent calls `show_user(kind: "echart", dataPath: "runs/run-abc/step-2/output/de-summary.csv")` with a spec encoding `x: "log2FC"`, `y: "padj"` and no `dataset.source`

#### Scenario: Small computed values

- **WHEN** the agent charts a handful of numbers it just derived in conversation (no artifact exists)
- **THEN** an inline `dataset.source` in the spec is appropriate and `dataPath` is omitted
