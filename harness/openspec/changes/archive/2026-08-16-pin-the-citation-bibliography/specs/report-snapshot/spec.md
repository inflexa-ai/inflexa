# Delta: report-snapshot

## MODIFIED Requirements

### Requirement: The pin collects the citation evidence
The pin MUST collect the citation ids of each run synthesis into the snapshot citation list: the key references, and the per-finding references. Each PMID becomes the key `pmid:<id>`, and the keys dedupe and sort in code-unit order. The collection reads the synthesis record of each run of the analysis. An absent synthesis, an unreadable one, and a malformed one each give no keys and no error, because absence is a normal condition. A composition that gives no workspace-root seam pins no citations, and the pin still lands. A failed run listing MUST fail the pin, because a store fault is not absence.

The pin MUST also store a citation record beside each key that carries one: the short citation, and the description. The records ride an optional map keyed by the citation key, and the key list keeps the membership role. The first record for a key wins, and the key references walk first, thus the curated description survives a narrower duplicate. A key with no record stays a bare key, and a stored pin with no map reads as today.

#### Scenario: A synthesis PMID becomes a pinned citation key

- **WHEN** the pin reads a synthesis whose key references carry PMID `12345`
- **THEN** the stored snapshot citation list holds `pmid:12345`

#### Scenario: A citation block over a pinned PMID resolves

- **WHEN** a citation reference names `pmid:12345` and the snapshot citation list holds that key
- **THEN** the reference resolves, and the gate passes it

#### Scenario: The record rides beside the key

- **WHEN** the pin reads a synthesis whose key reference carries PMID `12345` with the citation `Hugo et al. 2016`
- **THEN** the stored record map holds that citation under `pmid:12345`

#### Scenario: The curated record survives a duplicate

- **WHEN** a key reference and a finding reference both name PMID `12345`
- **THEN** the stored record is the key-reference one

#### Scenario: A legacy pin reads as today

- **WHEN** a stored pin holds the key list and no record map
- **THEN** the snapshot loads, and each reader falls back to the bare key
