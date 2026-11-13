## ADDED Requirements

### Requirement: A DOI citation key is in lower case

A DOI is case-insensitive. Thus the citation key of a DOI MUST be `doi:` and the DOI in lower case. The pin, the resolver, and the renderer MUST make the key with one function. The resolver MUST also compare an asserted DOI key in lower case. The key of each other id kind MUST stay as it is.

#### Scenario: An author types a DOI in a different case
- **GIVEN** a pinned citation key `doi:10.1093/bioinformatics/btw014`
- **WHEN** a citation reference names the DOI `10.1093/Bioinformatics/BTW014`, and asserts `doi:10.1093/BIOINFORMATICS/btw014`
- **THEN** the resolution gives the citation echo `doi:10.1093/bioinformatics/btw014`

## MODIFIED Requirements

### Requirement: The pin collects the citation evidence
The pin MUST collect the citation ids of each run synthesis into the snapshot citation list: the key references, and the per-finding references. Each PMID becomes the key `pmid:<id>`, and the keys dedupe and sort in code-unit order. The collection reads the synthesis record of each run of the analysis. An absent synthesis, an unreadable one, and a malformed one each give no keys and no error, because absence is a normal condition. A composition that gives no workspace-root seam pins no citations, and the pin still lands. A failed run listing MUST fail the pin, because a store fault is not absence.

The pin MUST also collect the method sources of each run. A method source is a DOI or a PubMed id of a claim view of the stored plan. It can also be a citation of a decision record of a step. The pin MUST collect each source, also a source past the bound of the display list. The record of a method source MUST be its title and its year. The pin MUST also collect the key of each method reference of a synthesis. A run with no synthesis MUST still give its method sources. A failed plan read MUST fail the pin with the kind `plan-read-failed`.

The pin MUST also store a citation record beside each key that carries one: the short citation, and the description. The records ride an optional map keyed by the citation key, and the key list keeps the membership role. The first record for a key wins, and the key references walk first, thus the curated description survives a narrower duplicate. A key with no record stays a bare key, and a stored pin with no map reads as today.

#### Scenario: A synthesis PMID becomes a pinned citation key
- **WHEN** the pin runs for an analysis whose run synthesis carries the key reference PMID `12345`
- **THEN** the stored snapshot citation list holds `pmid:12345`

#### Scenario: A citation block over a pinned PMID resolves
- **WHEN** a citation reference names `pmid:12345` and the snapshot citation list holds that key
- **THEN** the resolution gives the citation echo, and no refusal names the pinned evidence

#### Scenario: An absent synthesis pins no key and no error
- **WHEN** the pin runs for an analysis whose run directory holds no synthesis record
- **THEN** the pin lands with an empty citation list, and no failure returns

#### Scenario: A per-finding PMID pins too
- **WHEN** a synthesis carries a PMID only inside the references of one finding
- **THEN** the stored snapshot citation list holds its key

#### Scenario: Two runs that cite one paper pin one key
- **WHEN** two run syntheses carry one PMID
- **THEN** the citation list holds the key one time

#### Scenario: The record rides beside the key
- **WHEN** the pin reads a synthesis whose key reference carries PMID `12345` with the citation `Hugo et al. 2016`
- **THEN** the stored record map holds that citation under `pmid:12345`

#### Scenario: The curated record survives a duplicate
- **WHEN** a key reference and a finding reference both name PMID `12345`
- **THEN** the stored record is the key-reference one

#### Scenario: A legacy pin reads as today
- **WHEN** a stored pin holds the key list and no record map
- **THEN** the snapshot loads, and each reader falls back to the bare key

#### Scenario: A method source becomes a pinned citation key
- **GIVEN** a run with no synthesis, a claim view with a DOI, and a decision record with a PubMed id
- **WHEN** the pin runs for the analysis
- **THEN** the stored snapshot citation list holds the `doi:` key and the `pmid:` key, each with a record of its title and its year

#### Scenario: A failed plan read fails the pin
- **WHEN** the plan read of a run fails
- **THEN** the pin fails with the kind `plan-read-failed`
