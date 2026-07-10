# iterative-report Specification

## Purpose

Define iterative report authoring: the conversation agent's `iterate_report`
tool and the in-process report-builder loop it drives. Reports are built
**entirely inside the Cortex Node process** — there is no sandbox pod and no
`python build.py`. The report-builder is a non-plannable in-process agent driven
by `runToTerminal` over a `passthroughStep` (see the harness-agent-loop spec):
its file IO is the in-process `versionFs` tool roster, its rendering is Node-side
Nunjucks (`build_report` → `renderReport`), and its visual self-check is a single
headless-Chrome screenshot (`preview_snapshot`). The builder's LLM calls flow
through the `ChatProvider` seam under a `forSubAgent` session, so billing resolves
lazily at the call site — no sandbox, no ALS, no fetch-patch.

The split exists so the agent that *has* the analysis context curates the report
and the agent that *renders* it never has to discover anything. `iterate_report`
runs a Cortex-side pre-flight that stages every declared source into the
preview's shared `assets/` dir (parsing CSV/TSV header, first rows, and row
count into the brief) and hands the report-builder a complete brief — fully
composed sections, every asset already present. The builder therefore has **no
discovery surface** (`workspace_search`, `list_files`, `file_stat` are absent)
and no shell. A run that does not terminate in a successful `submit_report` is a
failure whose version directory is rolled back, so a half-built report never
leaks to the user.

Each iteration is a new version directory under
`{workspaceRoot}/previews/{previewId}/v{N}`; `assets/` is shared across versions.
(`previews/{analysisId}/{previewId}` is the content-token `res` claim — URL
space, not a filesystem sub-path.)
On success the tool emits a `data-preview` chat part; on any pre-flight, build,
or submit failure it emits `data-preview-failed`. The hosted preview surface is
reached only through the injected `PreviewPublisher` seam (the OSS default
returns "unavailable" so reports still build without a hosted preview).

## Requirements

### Requirement: iterate_report exposes mutually-exclusive creation and iteration modes


The conversation agent SHALL have an `iterate_report` tool with two modes, and
the input SHALL require exactly one of `report` (creation) or `modifications`
(iteration). The tool accepts `previewId` (optional lowercase-alphanumeric-dash,
auto-generated as `prv-{8 hex}` on first call), `baseVersion` (optional, defaults
to latest), `format` (`"html"` | `"pdf"`, default `"html"`), and a top-level
`sources` array (iteration-only — adding `sources` alongside `report` is
rejected). It SHALL return `{ previewId, version, previewPath, error?, notes? }`.

#### Scenario: Supplying both report and modifications is rejected

- **WHEN** `iterate_report` is called with both a `report` object and a `modifications` string
- **THEN** input validation fails before any work — exactly one of `report` or `modifications` must be provided

#### Scenario: First creation auto-generates a preview id

- **WHEN** the agent calls `iterate_report` with a `report` and no `previewId`
- **THEN** the tool generates a `prv-`-prefixed id, produces version 1, and returns `{ previewId, version: 1, previewPath }`

### Requirement: The report brief is a typed section union with intent and content


A creation `report` SHALL contain `title`, `audience`, optional `styleGuidance`,
a `sources` array, and a non-empty `sections` array. Each section SHALL be one of
the discriminated types `narrative`, `metrics`, `figure`, `table`, `chart`, or
`methods`, and SHALL carry `title`, `intent` (the conversation agent's emphasis
hint), and a type-specific `content` object. `narrative`/`methods` carry
`content.prose`; `metrics` carries `content.stats[]`; `figure` carries
`content.imageAsset`; `table` carries `content.dataAsset`; `chart` carries
exactly one of `content.dataAsset` or inline `content.data` plus `chartType` and
`encoding`. A `modifications` iteration SHALL pass only a natural-language change
string — the builder reads the prior template and applies it surgically.

#### Scenario: A chart section requires exactly one data source

- **WHEN** a `chart` section supplies both `dataAsset` and inline `data` (or neither)
- **THEN** validation rejects the section — a chart needs exactly one of `dataAsset` or `data`

#### Scenario: Iteration carries only modification text

- **WHEN** the agent calls `iterate_report` with an existing `previewId` and a `modifications` string
- **THEN** the report-builder receives the prior version's `report.html.j2` plus the change text, and applies only the requested changes rather than rewriting

### Requirement: Pre-flight stages sources and cross-checks creation briefs


Before invoking the builder, `iterate_report` SHALL copy every declared source
into the preview's shared `assets/` dir and enrich the brief with each asset's
kind, size, columns, head rows, and row count. For a creation brief it SHALL
verify that every section asset reference (`figure.imageAsset`,
`table.dataAsset`, `chart.dataAsset`) is among the staged assets. A pre-flight or
cross-check failure SHALL emit `data-preview-failed` and return an error result
without running the builder.

#### Scenario: A section references an unstaged asset

- **WHEN** a creation brief has a `figure` whose `imageAsset` is not present in `report.sources`
- **THEN** the tool emits `data-preview-failed` (errorKind `build`) and returns an error naming the missing reference, without starting the builder

### Requirement: The report-builder runs in-process via runToTerminal, with no sandbox or Python


The report-builder agent SHALL be a non-plannable in-process agent (not a member
of the sandbox-agent catalog) driven by `runToTerminal` over `passthroughStep`.
Its roster SHALL be the four custom report tools (`build_report`,
`submit_report`, `mint_preview_url`, `preview_snapshot`) plus the in-process
`versionFs` surface (`write_file`, `edit_file`, `read_file`, `mkdir`), all
constructed inside the runner so they share one closure-captured `outcome` cell
and the iteration's version-dir paths. The agent SHALL NOT have `execute_command`
or any sandbox/Python build path, and SHALL have no workspace discovery tools.

#### Scenario: The builder finalizes only through submit_report

- **WHEN** the report-builder run ends without `submit_report` recording a success outcome
- **THEN** `runToTerminal` grants one terminal-only salvage continuation; if the outcome cell is still empty the run is a failure

#### Scenario: The builder cannot shell out

- **WHEN** the report-builder needs to render the template
- **THEN** it calls the `build_report` tool (in-process Nunjucks) — there is no `execute_command` and no `python build.py` to invoke

### Requirement: Version directories are managed Cortex-side with shared assets and rollback


The runner SHALL serialize iterations per `previewId` (`withPreviewLock`),
resolve the new version as `max(latest, baseVersion) + 1`, create
`{workspaceRoot}/previews/{previewId}/v{N}` (where `{workspaceRoot}` is the
analysis's resolved workspace root — see workspace-root-resolution), copy the
base version's
`report.html.j2` forward when one exists, and symlink the version dir's `assets`
to the preview's shared `assets/`. On any failure (no outcome, agent error, or
phantom success) it SHALL remove the new version directory while leaving the
shared `assets/` untouched, and return a structured failure with `errorKind` in
`render | submit | build | timeout | internal`.

#### Scenario: A failed iteration is rolled back

- **WHEN** the builder errors or never submits for version N
- **THEN** the `v{N}` directory is removed, the shared `assets/` dir is left intact, and a failure result with an `errorKind` is returned

#### Scenario: Assets persist across versions

- **WHEN** a CSV staged into `assets/` during v1 is needed by a later version
- **THEN** it is reachable from v3 with no re-staging, because `assets/` is shared and each version dir symlinks to it

### Requirement: build_report renders the template via in-process Nunjucks


The `build_report` tool SHALL render `v{N}/report.html.j2` to `v{N}/index.html`
through the Node-side `renderReport` (Nunjucks, autoescape off). The loader
resolution order SHALL be `[versionDir, templatesDir/report-html]` so the
agent's `report.html.j2` resolves its `extends "base.html.j2"` and
`include "components/…"` from the shared templates dir. `echarts-theme.json`
SHALL be read, parsed, re-stringified, and exposed to the template as the
`echarts_theme` JSON string. Failures SHALL be returned as structured errors
with `kind` in `missing-template | syntax | runtime` (and a line number when
available), never thrown.

#### Scenario: A Jinja syntax error returns a structured error

- **WHEN** `report.html.j2` has a Nunjucks parse error
- **THEN** `build_report` returns `{ ok: false, error: { kind: "syntax", line, … } }` and the agent can fix and rebuild

### Requirement: preview_snapshot validates the rendered report in headless Chrome


The `preview_snapshot` tool SHALL navigate headless Chrome to the rendered
report URL, wait for the `inflexa-theme-ready` signal, and return a base64 PNG
screenshot together with collected console errors and failed network requests.
The preview URL SHALL be minted lazily through the injected `PreviewPublisher`
seam and cached in a cell shared with `mint_preview_url`. When the seam is
unavailable the tool SHALL return an `ok: false` result naming the mint failure
rather than throwing.

#### Scenario: Snapshot reports console and network problems

- **WHEN** the agent calls `preview_snapshot` after a green build
- **THEN** it receives a screenshot plus the page's console errors and failed requests, and decides whether to fix the template or proceed to `submit_report`

### Requirement: submit_report is the postcondition gate and emits the preview part


`submit_report` SHALL be the only signal that finalizes a version: it validates
that `index.html` exists and is non-empty, contains no unrendered Jinja markers,
and that every referenced local asset path resolves on disk, returning
`problems[]` when any check fails. Only on success does it record the terminal
outcome (with optional `notes`). The runner SHALL additionally apply a
phantom-success guard — treating a claimed success whose `index.html` is missing
or empty as a failure. On a recorded success `iterate_report` SHALL emit a
`data-preview` part `{ id, previewId, version, title, previewPath, format }`; on
failure it SHALL emit `data-preview-failed` `{ id, previewId, version, reason, errorKind }`.

#### Scenario: submit_report rejects unrendered Jinja

- **WHEN** `index.html` still contains `{{ … }}` or `{% … %}` markers
- **THEN** `submit_report` returns `problems[]`, does not record success, and the agent must fix and re-submit

#### Scenario: A clean submit emits data-preview

- **WHEN** `submit_report` records a success for version N
- **THEN** `iterate_report` emits a `data-preview` part carrying the title, `v{N}/index.html` preview path, and format, and returns `{ previewId, version: N, previewPath }`
