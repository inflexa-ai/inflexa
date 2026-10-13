## MODIFIED Requirements

### Requirement: A file reference resolves to file entities in the shared QName space

The prov module MUST resolve a lineage file reference against the `inflexa:file-*`
entities of the stored PROV document of the analysis. A match is an exact
`inflexa:path`, an exact `inflexa:hash`, or a hash prefix that matches exactly one
entity.

Some entities can carry the same exact path, because a later run can write that path
again. Then the reference MUST resolve to each of these entities. Each one is a
distinct entity, and the walk labels each one with its hash. An ambiguous hash prefix
MUST fail with a list of the candidate hashes and paths. An unmatched reference MUST
fail with a sample of the known file paths of the document.

A stored hash has the form `<scheme>:<digest>`, for example `sha256:<hex>`. A stored
hash with no colon is all digest. The hash tiers MUST obey these rules:

- An exact hash reference and a hash prefix MUST match the digest, with or without the scheme.
- A reference with a scheme MUST match only a hash with the same scheme.
- A hash prefix MUST have at least 6 characters of digest. The scheme does not count.
- Thus the scheme alone, for example `sha256` or `sha256:`, matches no file by hash.

The short hash of a tree, dot, or mermaid label MUST be the first 12 characters of the
digest, with no scheme. Thus a person can copy the label as a hash prefix.

#### Scenario: A path shared by two runs resolves to both entities

- **WHEN** `runs/run-001/step-de/output/results.csv` was written in run-001 and re-written with different bytes in run-002, and lineage is asked for that path
- **THEN** both file entities resolve, and the output renders one lineage per entity, each labeled with its content hash

#### Scenario: A unique hash prefix resolves; an ambiguous one fails with candidates

- **WHEN** lineage is asked for an 8-character prefix that matches the hash of exactly one entity
- **THEN** that entity resolves
- **AND** when the prefix matches two entities, the command fails with the two `(path, hash)` candidates, and it does not select one

#### Scenario: A bare hex prefix resolves with or without the scheme

- **GIVEN** a file entity whose hash is `sha256:<hex>`
- **WHEN** lineage is asked for the first 8 characters of `<hex>`, with no scheme, and then for the same 8 characters after `sha256:`
- **THEN** each reference resolves to that entity

#### Scenario: A bare full digest resolves

- **GIVEN** a file entity whose hash is `sha256:<hex>`
- **WHEN** lineage is asked for the full `<hex>`, with no scheme
- **THEN** that entity resolves

#### Scenario: The scheme alone matches no file

- **GIVEN** a document whose file hashes each start with `sha256:`
- **WHEN** lineage is asked for `sha256`, for `sha256:`, or for `sha256:` and 5 characters of a digest
- **THEN** no file resolves by hash, and the reference continues to the search tier

#### Scenario: A copied short hash resolves

- **GIVEN** a tree label that shows the short hash of a file entity
- **WHEN** lineage is asked for that short hash, and no other entity has a digest with the same 12 first characters
- **THEN** that entity resolves

#### Scenario: An unknown reference fails helpfully

- **WHEN** lineage is asked for a path/hash present nowhere in the document
- **THEN** the command fails and lists a sample of the file paths the document does contain
