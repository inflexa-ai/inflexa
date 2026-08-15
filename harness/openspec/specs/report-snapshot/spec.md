# report-snapshot Specification

## Purpose

Define the pinned artifact set that a report session resolves against. A report
session freezes at one moment, and the analysis continues after that anchor. The
snapshot states which artifacts existed at the anchor. Thus a session never cites an
artifact that a later run produced.

The artifact ledger holds one row for each path, and it keeps no history. Thus the
set at a past moment is not recoverable later, and the pin must run at the anchor.

The snapshot holds identity, and it holds no cell and no byte. A completed run output
cannot change under a report, because the path of a run output holds the run id. Thus
the snapshot is a membership boundary, and it is not an archive.

This capability also defines the structural tier of resolution. That tier answers
from the snapshot alone, and it opens no file. The value tier reads the artifact, and
the `report-grounding` capability defines its seam and its reason set.

## Requirements

### Requirement: The harness pins a snapshot for one analysis at a point in time

The harness MUST give an operation that pins a `ReportSnapshot` for one analysis.
The pin reads the artifact ledger, and it gives the set of artifacts that exist at
that moment. The moment is the time anchor of the report session.

The artifact ledger holds one row for each path, and it keeps no history. Thus the
set at a past moment is not recoverable later, and the pin must happen at that
moment.

The pin MUST include each row of the ledger, and it MUST filter no row. An artifact
whose bytes are unrecoverable stays a member, because it existed at the anchor. A
reference to it then fails at the value tier, and the reason names the real cause.

#### Scenario: The pin gives each registered artifact

- **WHEN** the pin runs for an analysis that holds three registered artifacts
- **THEN** the snapshot holds one entry for each of the three artifacts

#### Scenario: An analysis with no artifact gives an empty snapshot

- **WHEN** the pin runs for an analysis that holds no registered artifact
- **THEN** the snapshot holds no entry, and the pin reports no error

#### Scenario: An artifact that registers after the pin is absent

- **WHEN** a later run registers a new artifact after the pin
- **THEN** the snapshot from the earlier pin holds no entry for that artifact

#### Scenario: An artifact with unrecoverable bytes stays a member

- **WHEN** the pin runs for an analysis that holds a row with `unrecoverable_at` set
- **THEN** the snapshot holds an entry for that artifact

### Requirement: A snapshot entry holds a hash and a file type

An entry MUST hold the content hash. It MUST hold the file type when the ledger holds
one for that artifact. The path is the key of the `artifacts` map, and it is not a
field of the entry.

The pin MUST NOT copy a cell, and it MUST NOT copy the bytes of an artifact. The
entry pins identity only. The value tier reads the artifact when a value is
necessary.

#### Scenario: An entry carries the hash and the file type

- **WHEN** the pin makes an entry for a registered artifact
- **THEN** the entry holds the content hash and the file type of that artifact

#### Scenario: The path addresses the entry

- **WHEN** a reference names the analysis-relative path of a registered artifact
- **THEN** that path is the key that finds the entry in the `artifacts` map

#### Scenario: The pin copies no cell

- **WHEN** the pin runs for an analysis that holds a table of one million rows
- **THEN** the snapshot holds the entry of that table, and it holds no row of it

### Requirement: The pin collects the citation evidence
The pin MUST collect the key references of each run synthesis into the snapshot citation list. Each PMID becomes the key `pmid:<id>`, and the keys dedupe and sort in code-unit order. The collection reads the synthesis record of each run of the analysis. An absent synthesis, an unreadable one, and a malformed one each give no keys and no error, because absence is a normal condition. A composition that gives no workspace-root seam pins no citations, and the pin still lands. A failed run listing MUST fail the pin, because a store fault is not absence.

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

### Requirement: The snapshot is the membership boundary of a session

Resolution MUST refuse a path that the snapshot does not hold. The refusal MUST
happen even when a file exists at that path on disk. Thus a session never cites an
artifact that a later run produced, and the knowledge cap of the session holds.

The reason set of a refusal belongs to the `report-grounding` capability.

#### Scenario: A reference to a later artifact is refused

- **WHEN** a reference names a path that a run wrote after the pin
- **THEN** resolution returns an `UnresolvedReference` with reason `artifact-missing`

### Requirement: The structural validation reads the snapshot only

The structural validation MUST answer from the snapshot alone, and it MUST open no
file. It applies to the artifact pin of a reference. It answers three questions. Is
the path in the snapshot? Does the hash of the reference match the hash of the entry?
Does the file type of the entry refuse the kind of the reference?

The validation is instant, thus an authoring operation can run it on each change. A
value is not part of its answer, because a read of the artifact gives a value.

#### Scenario: A path outside the snapshot fails with no file read

- **WHEN** the structural validation runs on a reference to an absent path
- **THEN** it fails with reason `artifact-missing`, and it opens no file

#### Scenario: A hash that differs from the entry fails

- **WHEN** the structural validation runs on a reference whose `hash` differs from the entry
- **THEN** it fails with reason `hash-mismatch`

#### Scenario: A structural pass gives no value

- **WHEN** the structural validation passes on a reference that carries an `assert`
- **THEN** it reports the pass, and it does not match the assertion

### Requirement: The file type refuses a kind, and it never confirms one

The structural validation MUST refuse an `artifact-value` reference and an
`artifact-table` reference against an entry whose file type is `figure`, `script`,
`log`, or `notebook`. The reason MUST be `unreadable-artifact`. The file type states
a role, and it does not state a data format.

The validation MUST pass every other file type, and it MUST pass an entry that holds
no file type. A file type of `output` does not say whether the file holds a table,
and that question falls to the value tier.

An `artifact-file` reference pins the bytes of a whole file. Thus each file type is
valid for it.

#### Scenario: A value reference against a figure fails

- **WHEN** an `artifact-value` reference names an entry with a file type of `figure`
- **THEN** the structural validation fails with reason `unreadable-artifact`

#### Scenario: A table reference against a log fails

- **WHEN** an `artifact-table` reference names an entry with a file type of `log`
- **THEN** the structural validation fails with reason `unreadable-artifact`

#### Scenario: A value reference against an output passes

- **WHEN** an `artifact-value` reference names an entry with a file type of `output`
- **THEN** the structural validation passes

#### Scenario: An entry with no file type passes

- **WHEN** an `artifact-value` reference names an entry that holds no file type
- **THEN** the structural validation passes

#### Scenario: A file reference against a figure passes

- **WHEN** an `artifact-file` reference names an entry with a file type of `figure`
- **THEN** the structural validation passes

### Requirement: A reference with no artifact pin validates through its inputs

A `citation` reference and a `derivation` reference MUST hold no artifact pin. Thus
the structural validation has nothing to answer for a `citation`, and the citation
passes. The gate validates a citation at the value tier.

A `derivation` MUST validate through its two inputs. Each input holds an artifact
pin. The derivation passes when both inputs pass. It fails with the reason of the
first input that fails.

#### Scenario: A citation passes the structural validation

- **WHEN** the structural validation runs on a `citation` reference
- **THEN** it passes, because the reference holds no artifact pin

#### Scenario: A derivation with two valid inputs passes

- **WHEN** the structural validation runs on a `derivation` whose two inputs both pass
- **THEN** the derivation passes

#### Scenario: A derivation with one absent input fails

- **WHEN** a `derivation` holds one input whose path the snapshot does not hold
- **THEN** the derivation fails with reason `artifact-missing`
