## ADDED Requirements

### Requirement: Manuscript dossiers and reviewed copies are registered run artifacts

The host-side manuscript workflow SHALL register validated `review.json` through `ArtifactRegistry` with its analysis id, run id, producing phase identity, confined relative path, SHA-256, size, and review-dossier file type before terminal completion. `emit_review_docx` SHALL likewise register each validated reviewed copy with the source run and deterministic output identity. Registration SHALL occur only after atomic write and validation, and an unregistered on-disk file SHALL NOT be advertised by run inspection or treated as an idempotent reviewed copy.

#### Scenario: Dossier registration precedes completion

- **WHEN** dossier persistence succeeds
- **THEN** the artifact row contains the dossier hash, size, run, phase, and path before the run-completed event

#### Scenario: Reviewed copy is registered after validation

- **WHEN** comment injection and output validation succeed
- **THEN** the reviewed DOCX is hashed and registered with its source run and deterministic identity

#### Scenario: Registration fails

- **WHEN** artifact registration fails after a temporary dossier or reviewed copy was written
- **THEN** the operation does not advertise that path as a successful artifact
