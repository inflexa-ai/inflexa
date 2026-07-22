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
On success the tool emits a `data-report-preview` chat part; on any pre-flight,
build, or submit failure it emits `data-report-preview-failed`. The hosted preview
surface is reached only through the injected `PreviewPublisher` seam (the OSS default
returns "unavailable" so reports still build without a hosted preview).
## Requirements
### Requirement: iterate_report exposes mutually-exclusive creation and iteration modes

The conversation agent SHALL submit report briefs through `submit_report` (with
`plan_report` delivering the brief schema just-in-time), and the input SHALL
require exactly one of `report` (creation) or `modifications` (iteration). The
tool accepts `previewId` (optional lowercase-alphanumeric-dash, auto-generated as
`prv-{8 hex}` on first call), `baseVersion` (optional, defaults to latest),
`format`, and a top-level `sources` array (iteration-only — adding `sources`
alongside `report` is rejected). It SHALL return
`{ previewId, version, previewPath, error?, notes? }`.

`format` SHALL accept only `"html"`, which is also its default. The system
produces no other output format: the rendered artifact is always
`v{N}/index.html`. A request for any other format SHALL be rejected at the tool
boundary rather than accepted and silently satisfied with HTML. The `format`
field carried on `preview-meta.json` and the `data-report-preview` part retains
its wider `"html" | "pdf"` type so previews persisted before this restriction
still parse.

#### Scenario: Supplying both report and modifications is rejected

- **WHEN** `submit_report` is called with both a `report` object and a `modifications` string
- **THEN** input validation fails before any work — exactly one of `report` or `modifications` must be provided

#### Scenario: First creation auto-generates a preview id

- **WHEN** the agent calls `submit_report` with a `report` and no `previewId`
- **THEN** the tool generates a `prv-`-prefixed id, produces version 1, and returns `{ previewId, version: 1, previewPath }`

#### Scenario: A non-HTML format is refused at the boundary

- **WHEN** the agent calls `submit_report` with `format: "pdf"`
- **THEN** input validation rejects the call, and no preview version is created

#### Scenario: A persisted preview recorded before the restriction still loads

- **GIVEN** a `preview-meta.json` written with `format: "pdf"`
- **WHEN** that preview's metadata is read for a later iteration
- **THEN** it parses successfully and the recorded format is preserved

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
cross-check failure SHALL emit `data-report-preview-failed` and return an error
result without running the builder.

#### Scenario: A section references an unstaged asset

- **WHEN** a creation brief has a `figure` whose `imageAsset` is not present in `report.sources`
- **THEN** the tool emits `data-report-preview-failed` (errorKind `build`) and returns an error naming the missing reference, without starting the builder

### Requirement: Iteration against an unknown preview is refused before any work

The submitting tool SHALL verify, on an iteration call, that the named
`previewId` resolves to an existing preview holding at least one version, and
SHALL refuse the call with an actionable error when it does not. Iteration mode
(`modifications` without a `report`) carries no brief — the builder's entire
input is the change text plus the previous version's template.

The refusal SHALL happen before minting preview access, staging any source, or
starting the report-builder, so an unknown id costs no model turns. Without this
check the run silently produces a fresh `v1` with no base template while the
builder is instructed that the previous template "is already in your working
directory" and forbidden from rewriting it — leaving it with a change request and
nothing to change.

#### Scenario: Iterating an unknown preview id is refused

- **WHEN** the agent calls `submit_report` with `modifications` and a `previewId` that has no preview directory
- **THEN** the call fails with an error naming the unknown `previewId`, no version directory is created, and the report-builder is never started

#### Scenario: Iterating a preview with no versions is refused

- **GIVEN** a preview directory that exists but contains no `v{N}` version
- **WHEN** the agent calls `submit_report` with `modifications` for that `previewId`
- **THEN** the call fails with an actionable error rather than producing a fresh version 1

#### Scenario: Iterating an existing preview still succeeds

- **GIVEN** a preview whose latest version is 2
- **WHEN** the agent calls `submit_report` with `modifications` for that `previewId`
- **THEN** the check passes and version 3 is produced from version 2's template

### Requirement: The report-builder runs in-process via runToTerminal, with no sandbox or Python

The report-builder agent SHALL be a non-plannable in-process agent (not a member
of the sandbox-agent catalog) driven by `runToTerminal` over `passthroughStep`.
Its roster SHALL be the four custom report tools (`build_report`,
`submit_report`, `mint_preview_url`, `preview_snapshot`), the in-process
`versionFs` surface (`write_file`, `edit_file`, `read_file`, `mkdir`), and the
read-only skill tools (`skill_search`, `skill_read`) scoped to the `report-html`
pack — all constructed inside the runner so the report/version tools share one
closure-captured `outcome` cell and the iteration's version-dir paths. The skill
tools SHALL be constructed via `createSkillTools({ skillsDir, skills:
["report-html"] })` so the design-system reference the builder prompt directs the
model to read (`skill_read("report-html", "references/design-system.md")`) is
actually reachable. The agent SHALL NOT have `execute_command` or any
sandbox/Python build path, and SHALL have no workspace discovery tools.

#### Scenario: The builder finalizes only through submit_report

- **WHEN** the report-builder run ends without `submit_report` recording a success outcome
- **THEN** `runToTerminal` grants one terminal-only salvage continuation; if the outcome cell is still empty the run is a failure

#### Scenario: The builder cannot shell out

- **WHEN** the report-builder needs to render the template
- **THEN** it calls the `build_report` tool (in-process Nunjucks) — there is no `execute_command` and no `python build.py` to invoke

#### Scenario: The builder can read the report-html skill pack

- **GIVEN** the report-builder prompt directs the model to `skill_read` the `report-html` design-system reference
- **WHEN** the model calls `skill_read("report-html", "references/design-system.md")`
- **THEN** the call resolves against the declared `report-html` pack rather than failing as an undeclared skill or an unavailable tool

### Requirement: The version filesystem refuses absolute paths

The `versionFs` tools SHALL reject any path beginning with a slash as
`out_of_scope`, matching the contract their descriptions and the builder prompt
already state. This covers `write_file`, `edit_file`, `read_file`, and `mkdir`. A
rejection SHALL name the offending path so the agent can retry with a relative one.

An absolute path SHALL NOT be silently reinterpreted as relative to the version
directory. Rewriting it produces a real file at an unintended nested location and
returns success, after which `build_report` reports the authored template as
missing and the builder — which has no directory-listing tool — cannot discover
what happened.

#### Scenario: An absolute write is refused rather than relocated

- **WHEN** the builder calls `write_file` with `/previews/abc/v1/report.html.j2`
- **THEN** the call returns `out_of_scope` naming that path, and no file is created

#### Scenario: A relative path is unaffected

- **WHEN** the builder calls `write_file` with `report.html.j2`
- **THEN** the file is written inside the version directory and the call returns `ok`

#### Scenario: Traversal outside the version directory remains refused

- **WHEN** the builder calls `read_file` with `../../etc/passwd`
- **THEN** the call returns `out_of_scope` and no file is read

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

An unavailable seam SHALL additionally be reported through the injected `Logger`,
because it means the build's only visual verification step did not run — a
condition an operator must be able to see without reading the model transcript.

A mint failure surfaced to the model SHALL name only fields the seam actually
supplied; an absent HTTP status SHALL be omitted rather than interpolated. This
binds every tool that surfaces one — `mint_preview_url` as well as
`preview_snapshot` — through a single shared composition, so the two cannot
describe the same failure differently.

#### Scenario: Snapshot reports console and network problems

- **WHEN** the agent calls `preview_snapshot` after a green build
- **THEN** it receives a screenshot plus the page's console errors and failed requests, and decides whether to fix the template or proceed to `submit_report`

#### Scenario: An unavailable preview seam is logged, not silent

- **GIVEN** a `PreviewPublisher` realization that reports the preview surface unavailable
- **WHEN** the agent calls `preview_snapshot`
- **THEN** the tool returns `ok: false`, and a warning carrying the `previewId` is emitted through the injected `Logger`

#### Scenario: A mint failure without a status omits the field

- **GIVEN** a mint failure carrying no HTTP status
- **WHEN** either `preview_snapshot` or `mint_preview_url` composes its error message
- **THEN** the message names the failure reason and contains no `status=undefined` text

#### Scenario: A mint failure carrying a status keeps it

- **GIVEN** a mint failure carrying an HTTP status
- **WHEN** either preview tool composes its error message
- **THEN** the status appears in the message, so the omission above is a response to absence rather than a fixed string

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


### Requirement: Agent-facing copy names only capabilities that exist

Tool descriptions and agent prompts on the report path SHALL name only tools,
parameters, files, and behaviours the implementation actually provides. This copy
is the one layer no typechecker validates, so a stale claim stays green until an
agent acts on it and then fails silently or wastes turns.

Concretely: a prompt SHALL NOT list a tool absent from the agent's roster; a tool
description SHALL NOT offer an outcome the implementation cannot reach; a stated
constant SHALL match the value the code uses; and a prompt SHALL NOT direct an
agent to a file it has no tool capable of reading.

#### Scenario: The builder prompt lists only tools on its roster

- **WHEN** the report-builder prompt enumerates its file tools
- **THEN** it names exactly the tools the runner constructs, and no others

#### Scenario: A description does not offer an unreachable outcome

- **GIVEN** pre-flight fails the whole call when a source exceeds the asset size cap
- **WHEN** the builder's `submit_report` description explains what `notes` are for
- **THEN** it does not offer skipped-oversized-source reporting as an example, because no such skip occurs

#### Scenario: A stated lifetime matches the code

- **WHEN** a preview tool description states an access lifetime
- **THEN** that value matches the TTL the implementation requests, or the description omits a specific figure

#### Scenario: A prompt does not name an unreadable file

- **GIVEN** the report-builder's `read_file` is confined to the version directory
- **WHEN** the creation prompt names the design-system material to work within
- **THEN** it names only material reachable through the builder's tools
