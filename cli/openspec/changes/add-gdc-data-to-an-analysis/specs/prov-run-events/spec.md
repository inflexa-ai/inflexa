## ADDED Requirements

### Requirement: The acquisition provenance event exists in the bus contract

The `BusEvent` union MUST carry `prov.input_acquired`. The member carries the
`analysisId`, a `ProvActor`, the input ref, and the acquisition ref. The two
ref types MUST come from `@inflexa-ai/prov-kernel`, re-exported through
`src/types/prov.ts`. The event lives in `src/types/events.ts`.

The bus telemetry projection MUST give the analysis id, the actor kind, the
input path, the source name, the release, and the file count. It MUST NOT
give a URL, a digest, or the request. The payload MUST NOT carry an API key
or a credentialed URL.

#### Scenario: A download crosses the bus

- **WHEN** the realization of the input-acquisition seam adds a downloaded
  input
- **THEN** the bus receives one `prov.input_acquired` with the input ref and
  the acquisition ref
- **AND** the telemetry line gives the source name, the release, and the file
  count

### Requirement: The recorder maps the acquisition event through the kernel

The recorder MUST send `prov.input_acquired` through `toKernelEvent` and
`applyProvEvent`, as it sends the core family. No host-side branch exists for
the member. The flush, the chain hash, and the signing path MUST NOT change.

#### Scenario: A download lands in the signed document

- **WHEN** `prov.input_acquired` and then `prov.input_added` reach the
  recorder, and the document flushes
- **THEN** the stored document holds the `inflexa:AcquireInput` action, one
  `inflexa:Source` entity for each item, and the `inflexa:AddInput` action
- **AND** the signing columns change as for each other flush
