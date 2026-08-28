# prov-run-events — delta

## ADDED Requirements

### Requirement: Report provenance events exist in the bus contract

The `BusEvent` union MUST carry the report provenance family, each member scoped by `analysisId` and stamped with a `ProvActor`. Each member also carries `model: ProvModelId`, the model that drives the session at emit time:

- `prov.session_created` — carries `session: { threadId, kind: "conversation" | "report", parentThreadId? }`. One member records both session kinds, because to start a session is one domain action and the kind is its data.
- `prov.report_block_added`, `prov.report_block_changed`, `prov.report_block_removed`, `prov.report_block_moved` — each carries `threadId`, `blockId`, and `blockKind`.
- `prov.report_title_set` — carries `threadId` and `title`.
- `prov.report_derivation_run` — carries `threadId`, `outputPath`, `outputHash`, `scriptHash`, and `sources` as `(path, hash)` pairs.
- `prov.report_previewed` — carries `threadId`, `pagePath`, and `documentHash`.
- `prov.report_version_recorded` — carries `threadId`, `versionId`, and `replaced`.

The payload ref types MUST come from `@inflexa-ai/prov-kernel`, re-exported through `src/types/prov.ts` like the core refs, because the kernel owns the dialect shapes. The events live in `src/types/events.ts`. The bus telemetry projection MUST surface identifying fields for each member: the thread id, plus the block id and its kind, the version id, or the output path where the member carries one. The payload MUST NOT carry API keys, credentialed URLs, or prompt content.

#### Scenario: A report session creation crosses the bus

- **WHEN** the harness reports a created report session with its parent thread
- **THEN** the bus receives one `prov.session_created` whose session carries the thread id, the kind `report`, and the parent thread id

#### Scenario: A block act crosses the bus

- **WHEN** the harness reports a changed chart block
- **THEN** the bus receives one `prov.report_block_changed` with the thread id, the block id, and the kind `chart`

### Requirement: The recorder maps the report family through the kernel

The recorder MUST send every report member through `toKernelEvent` and `applyProvEvent`, the same path the core family walks. No host-side mapping branch exists, and the recorder holds no report builders. The kernel arms own the statements: the typed lifecycle actions, the report entity, the version entity, and the first-declaration guards. The flush, the chain hash, and the signing path MUST NOT change. The existing recorder guard drops an event whose `analysisId` has no analysis row, and a builder throw logs and returns.

#### Scenario: A report session lands in the signed document

- **WHEN** `prov.session_created` with kind `report` reaches the recorder and the document flushes
- **THEN** the stored document holds the `inflexa:Report` entity, the `inflexa:CreateSession` action, and the unchanged signing columns beside them

#### Scenario: A version record attaches to its report

- **WHEN** `prov.report_version_recorded` reaches the recorder for a thread with a report entity
- **THEN** the document holds an `inflexa:ReportVersion` entity attributed to that report entity

#### Scenario: A double emit stays one record

- **WHEN** two `prov.session_created` events with kind `report` arrive for one thread
- **THEN** the flushed document holds one generation edge and one attribution on the report entity

#### Scenario: The whole family compiles through the kernel

- **WHEN** a new `prov.*` member lands without a kernel counterpart
- **THEN** the build fails in the kernel dispatch, for a report member and a core member alike
