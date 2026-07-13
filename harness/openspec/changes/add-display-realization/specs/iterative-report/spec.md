# iterative-report — delta

Renames the preview chat parts to content-noun names: `data-preview` →
`data-report-preview`, `data-preview-failed` → `data-report-preview-failed`.
Purpose prose updates accordingly. No behavioral change; reconstruction keys
on the `iterate_report` tool name, so historical transcripts reconstruct under
the new names without migration.

## MODIFIED Requirements

### Requirement: Pre-flight stages sources and cross-checks creation briefs

Before invoking the builder, `iterate_report` SHALL copy every declared source
into the preview's shared `assets/` dir and enrich the brief with each asset's
kind, size, columns, head rows, and row count. For a creation brief it SHALL
verify that every section asset reference (`figure.imageAsset`,
`table.dataAsset`, `chart.dataAsset`) is among the staged assets. A pre-flight or
cross-check failure SHALL emit `data-report-preview-failed` and return an error
result without running the builder.

#### Scenario: A section references an unstaged asset

- **WHEN** a creation brief has a `figure` whose `imageAsset` is not present in `report.sources`
- **THEN** the tool emits `data-report-preview-failed` (errorKind `build`) and returns an error naming the missing reference, without starting the builder

### Requirement: submit_report is the postcondition gate and emits the preview part

`submit_report` SHALL be the only signal that finalizes a version: it validates
that `index.html` exists and is non-empty, contains no unrendered Jinja markers,
and that every referenced local asset path resolves on disk, returning
`problems[]` when any check fails. Only on success does it record the terminal
outcome (with optional `notes`). The runner SHALL additionally apply a
phantom-success guard — treating a claimed success whose `index.html` is missing
or empty as a failure. On a recorded success `iterate_report` SHALL emit a
`data-report-preview` part `{ id, previewId, version, title, previewPath, format }`;
on failure it SHALL emit `data-report-preview-failed`
`{ id, previewId, version, reason, errorKind }`.

#### Scenario: submit_report rejects unrendered Jinja

- **WHEN** `index.html` still contains `{{ … }}` or `{% … %}` markers
- **THEN** `submit_report` returns `problems[]`, does not record success, and the agent must fix and re-submit

#### Scenario: A clean submit emits data-report-preview

- **WHEN** `submit_report` records a success for version N
- **THEN** `iterate_report` emits a `data-report-preview` part carrying the title, `v{N}/index.html` preview path, and format, and returns `{ previewId, version: N, previewPath }`
