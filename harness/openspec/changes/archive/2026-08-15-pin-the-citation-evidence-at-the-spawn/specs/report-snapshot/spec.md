# Delta: report-snapshot

## ADDED Requirements

### Requirement: The pin collects the citation evidence
The pin MUST collect the citation ids of each run synthesis into the snapshot citation list: the key references, and the per-finding references. Each PMID becomes the key `pmid:<id>`, and the keys dedupe and sort in code-unit order. The collection reads the synthesis record of each run of the analysis. An absent synthesis, an unreadable one, and a malformed one each give no keys and no error, because absence is a normal condition. A composition that gives no workspace-root seam pins no citations, and the pin still lands. A failed run listing MUST fail the pin, because a store fault is not absence.

#### Scenario: A synthesis PMID becomes a pinned citation key
- **WHEN** the pin runs for an analysis whose run synthesis carries the key reference PMID `12345`
- **THEN** the stored snapshot citation list holds `pmid:12345`

#### Scenario: A citation block over a pinned PMID resolves
- **WHEN** a citation reference names `pmid:12345` and the snapshot citation list holds that key
- **THEN** the resolution gives the citation echo, and no refusal names the pinned evidence

#### Scenario: An absent synthesis pins no key and no error
- **WHEN** the pin runs for an analysis whose run directory holds no synthesis record
- **THEN** the pin lands with an empty citation list, and no failure returns

#### Scenario: Two runs that cite one paper pin one key
- **WHEN** two run syntheses carry one PMID
- **THEN** the citation list holds the key one time
