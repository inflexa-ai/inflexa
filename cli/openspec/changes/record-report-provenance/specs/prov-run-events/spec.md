# prov-run-events — delta

## ADDED Requirements

### Requirement: Report provenance events exist in the bus contract

The `BusEvent` union MUST carry the report provenance family, each member scoped by `analysisId` and stamped with a `ProvActor`. Each member also carries `model: ProvModelId`, the model that drives the session at emit time:

- `prov.session_created` — carries `session: { threadId, kind: "conversation" | "report", parentThreadId? }`. One member records both session kinds, because creating a session is one domain action and the kind is its data.
- `prov.report_block_added`, `prov.report_block_changed`, `prov.report_block_removed`, `prov.report_block_moved` — each carries `threadId` and `blockId`.
- `prov.report_title_set` — carries `threadId` and `title`.
- `prov.report_derivation_run` — carries `threadId`, `outputPath`, `outputHash`, `scriptHash`, and `sources` as `(path, hash)` pairs.
- `prov.report_previewed` — carries `threadId`, `pagePath`, and `documentHash`.
- `prov.report_version_recorded` — carries `threadId`, `versionId`, and `replaced`.

The payload types MUST live in `src/types/prov.ts` as cli-owned shapes, and the events in `src/types/events.ts`. The bus telemetry projection MUST surface identifying fields for each member: the thread id, plus the block id, the version id, or the output path where the member carries one. The payload MUST NOT carry API keys, credentialed URLs, or prompt content.

#### Scenario: A report session creation crosses the bus

- **WHEN** the harness reports a created report session with its parent thread
- **THEN** the bus receives one `prov.session_created` whose session carries the thread id, the kind `report`, and the parent thread id

#### Scenario: A block act crosses the bus

- **WHEN** the harness reports a changed block
- **THEN** the bus receives one `prov.report_block_changed` with the thread id and the block id

### Requirement: The recorder maps the report family in the host

The recorder MUST map each report member before the kernel dispatch, thus the kernel-counterpart compile guard keeps its force for the core family. The mapping MUST write through the loaded document of the analysis and the kernel extension primitive `appendLifecycleAction`:

- `prov.session_created` records one `inflexa:CreateSession` action for both kinds, and the kind rides as an attribute. With kind `report`, the mapping also mints an `inflexa:Report` entity, with the parent thread as an attribute. A QName over `cliProvDigest` of the thread id keys the entity, thus two implementations compute one identifier.
- Each block act, the title act, the derivation act, and the preview act MUST land as one typed lifecycle action. The action carries `inflexa:threadId` and the data of its act.
- `prov.report_version_recorded` lands an `inflexa:RecordReportVersion` action and mints an `inflexa:ReportVersion` entity with the version id. The version entity specializes the report entity of its thread, because a version is the report at one moment.

The mapping MUST record the model as an `inflexa:Model` software agent on behalf of the system agent, as the step records do. Each report act MUST draw a `used` edge to the report entity of its thread, thus the entity anchors every act.

When a report act arrives for a thread with no report entity, the mapping MUST mint the entity first, and then it lands the act. Such a lazy mint carries no parent attribute, because the creation event never arrived.

A mapping throw MUST log and return, and it MUST NOT unwind into the emitter. The flush, the chain hash, and the signing path MUST NOT change. The existing recorder guard drops an event whose `analysisId` has no analysis row.

#### Scenario: A report session lands in the signed document

- **WHEN** `prov.session_created` with kind `report` reaches the recorder and the document flushes
- **THEN** the stored document holds the `inflexa:Report` entity, the `inflexa:CreateSession` action, and the unchanged signing columns beside them

#### Scenario: A version record attaches to its report

- **WHEN** `prov.report_version_recorded` reaches the recorder for a thread with a report entity
- **THEN** the document holds an `inflexa:ReportVersion` entity attributed to that report entity

#### Scenario: A version record for an unseen thread

- **WHEN** `prov.report_version_recorded` arrives for a thread with no report entity in the document
- **THEN** the mapping mints the report entity without a parent attribute, and the version entity specializes it

#### Scenario: The core family still compiles through the kernel

- **WHEN** a new core `prov.*` member lands without a kernel counterpart
- **THEN** the build fails in the kernel dispatch, exactly as before this family existed
