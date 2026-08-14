# iterative-report Delta

## MODIFIED Requirements

### Requirement: submit_report exposes mutually-exclusive creation and iteration modes

`submit_report` MUST be the brief-submission surface of the old report path, and `plan_report` MUST deliver the brief schema just-in-time. Neither tool is on the roster of the conversation agent. The report capability of a conversation is the report session — refer to the `report-session-spawn` capability. The two modules stay in the source until their removal, and this requirement binds them wherever they are constructed.

The input MUST carry exactly one of `report` (creation) or `modifications` (iteration), and never both. The tool accepts `previewId` (optional lowercase-alphanumeric-dash, auto-generated as `prv-{8 hex}` on first call), `baseVersion` (optional, defaults to latest), `format`, and a top-level `sources` array (iteration-only — `sources` beside `report` is rejected). It MUST return `{ previewId, version, previewPath, error?, notes? }`.

`format` MUST accept only `"html"`, which is also its default. The system produces no other output format: the rendered artifact is always `v{N}/index.html`. The tool MUST reject a request for a different format at the tool boundary. It must not accept the request and silently give HTML.

The `format` field on `preview-meta.json` and on the `data-report-preview` part keeps its wider `"html" | "pdf"` type. Thus a preview persisted before this restriction still parses.

#### Scenario: The pair is off the conversation roster

- **WHEN** the assembled conversation agent lists its tools
- **THEN** neither `plan_report` nor `submit_report` is present

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
