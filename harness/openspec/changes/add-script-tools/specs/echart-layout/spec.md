# Spec Delta

## MODIFIED Requirements

### Requirement: Artifact-sourced data goes through dataPath, not inline rows

The agent SHALL chart data that already exists as a chart-ready artifact (e.g.
a CSV a sandbox step wrote) by referencing it via `show_user`'s `dataPath`
param instead of reading the file and inlining its rows into the spec. The
spec SHALL omit `dataset.source` and author `encode` and dimension references
against the artifact's column names (read from the CSV header — the agent
never needs the data rows). Inline data remains appropriate only for small,
just-computed values that exist nowhere as an artifact. When the raw data is
not chart-ready (needs aggregation, filtering, reshaping), the agent prepares
it with `run_script`: `read_table`, then `write_derived` of a chart-ready CSV,
whose path goes to `dataPath`. The rows stay out of the spec and out of the
agent's context window.

This one remains an agent obligation because no renderer can supply it: the choice to
push rows through the model's context window instead of naming the artifact is made
before the spec exists.

#### Scenario: Charting a step output

- **GIVEN** a run step wrote `runs/run-abc/step-2/output/de-summary.csv` with header `gene,log2FC,padj`
- **WHEN** the agent charts it
- **THEN** the agent calls `show_user(kind: "echart", dataPath: "runs/run-abc/step-2/output/de-summary.csv")` with a spec encoding `x: "log2FC"`, `y: "padj"` and no `dataset.source`

#### Scenario: Small computed values

- **WHEN** the agent charts a handful of numbers it just derived in conversation (no artifact exists)
- **THEN** an inline `dataset.source` in the spec is appropriate and `dataPath` is omitted

#### Scenario: Data that is not chart-ready

- **WHEN** the agent charts the top genes of a result table
- **THEN** a script writes the chart-ready CSV with `write_derived`, and `show_user` names its path in `dataPath`
