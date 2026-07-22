## MODIFIED Requirements

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
The returned message SHALL name only fields the seam actually supplied; an absent
HTTP status SHALL be omitted rather than interpolated.

#### Scenario: Snapshot reports console and network problems

- **WHEN** the agent calls `preview_snapshot` after a green build
- **THEN** it receives a screenshot plus the page's console errors and failed requests, and decides whether to fix the template or proceed to `submit_report`

#### Scenario: An unavailable preview seam is logged, not silent

- **GIVEN** a `PreviewPublisher` realization that reports the preview surface unavailable
- **WHEN** the agent calls `preview_snapshot`
- **THEN** the tool returns `ok: false`, and a warning carrying the `previewId` is emitted through the injected `Logger`

#### Scenario: A mint failure without a status omits the field

- **GIVEN** a mint failure carrying no HTTP status
- **WHEN** `preview_snapshot` composes its error message
- **THEN** the message names the failure reason and contains no `status=undefined` text

## ADDED Requirements

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
