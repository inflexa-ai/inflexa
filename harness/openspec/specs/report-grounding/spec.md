# report-grounding Specification

## Purpose

Define how a report block binds to the evidence that justifies it, and how that
binding resolves to a concrete value. One canonical `Reference` object carries the
binding. It reuses the coordinates that the harness already keys on, the run id
`cortex_runs.run_id` and the file key `cortex_artifacts(path, hash)`.

Mechanical validation resolves each reference against a pinned snapshot and matches
the authored assertion. It uses no model, and it gives a hard guarantee that a number
in a report is real and correctly transcribed. A `claim` whose binding does not
resolve fails validation. This is the mechanism that prevents fabrication.

Semantic validation is a different concern. Whether the prose follows from the value
is model-dependent, thus it stays in a later verification pass and never in this
contract.

This capability is distinct from `target-synthesis-grounding`, which supplies FDA
approval precedents as prompt context for a target dossier.

## Requirements

### Requirement: A reference is one canonical shape

The harness MUST define one `Reference` object, and every evidentiary block MUST
carry it. A reference MUST carry a `kind` of `artifact-value`, `artifact-table`,
`artifact-file`, `derivation`, or `citation`. An artifact reference MUST pin `path`
and `hash`, and it can carry a `run` and a `snapshot`. It can carry a `unit` and a
`format`. The reference MUST reuse the coordinates that the harness already keys on,
the run id `cortex_runs.run_id` and the file key `cortex_artifacts(path, hash)`. The
`path` MUST be analysis-relative, because `cortex_artifacts` keys on `(analysis_id,
path)` and that path already holds the run segment of a run output.

The `run` MUST be optional. A staged input file under `data/inputs/` has no run that
produced it. Thus a mandatory `run` prevents a binding to an input file.

#### Scenario: A staged input artifact binds without a run

- **WHEN** a reference names an input file that no run produced, with a `path` and a `hash` but no `run`
- **THEN** the grounding contract accepts the reference shape

An `artifact-value` reference MUST address one value with a `locator`. An
`artifact-table` and an `artifact-file` reference MUST pin the whole file, and they
MUST carry no `locator`. A `figure` binds to an `artifact-file`, because an image has
no per-cell address.

#### Scenario: A complete artifact-value reference validates

- **WHEN** a reference carries `kind: "artifact-value"`, a `run`, a `path`, a `hash`, and a `locator`
- **THEN** the grounding contract accepts the reference shape

#### Scenario: A reference without a hash is rejected

- **WHEN** an artifact reference carries a `run` and a `path` but no `hash`
- **THEN** validation rejects the reference, because the hash is the identity under immutability

#### Scenario: A whole-file reference with a locator is rejected

- **WHEN** an `artifact-file` reference carries a `locator`
- **THEN** validation rejects the reference, because a whole-file pin addresses no cell

#### Scenario: A figure resolves through a whole-file pin

- **WHEN** a `figure` binds to an `artifact-file` whose path and hash match the snapshot
- **THEN** resolution returns the pinned file

### Requirement: The row locator defaults to a stable predicate

The `locator` MUST support `column`, `rowFilter`, and `row`. The default row selector
MUST be `rowFilter`, a stable predicate, because scientific table row order is not
semantically stable. A `row` by index MUST be permitted, but it MUST NOT be the
default. A locator MUST resolve to exactly one value. Zero matches MUST give
`locator-out-of-range`, and more than one match MUST give `ambiguous-match`.

#### Scenario: A rowFilter selects a row by a key column

- **WHEN** a locator carries a `rowFilter` that names a column, an operator, and a value that matches one row
- **THEN** resolution selects the matching row independent of its position

#### Scenario: A row index resolves when the order is fixed

- **WHEN** a locator carries a `row` index against an artifact with a fixed order
- **THEN** resolution selects the row at that index

#### Scenario: A rowFilter with many matches returns ambiguous-match

- **WHEN** a locator carries a `rowFilter` that matches more than one row
- **THEN** resolution returns an `UnresolvedReference` with reason `ambiguous-match`

### Requirement: A column name must address a real column

A column name that no row of the bound table holds MUST give
`locator-out-of-range`. This covers the `columns` subset of an `artifact-table`
reference and each channel of a `chart` encoding. A projection onto a name that
addresses nothing gives an empty cell for each row. Thus without this rule an
invented column resolves, and the report renders as grounded.

A table with no rows MUST accept each name. There is no evidence against a name, and
an empty result table is a real outcome.

A column that only some rows hold MUST resolve. A table tolerates a ragged row, thus
a sparse column is different from a column that does not exist.

#### Scenario: An invented column subset is rejected

- **WHEN** an `artifact-table` reference names a `columns` entry that no row holds
- **THEN** resolution returns an `UnresolvedReference` with reason `locator-out-of-range`

#### Scenario: A chart channel that names no real column is rejected

- **WHEN** a `chart` encoding names a column that the bound table does not hold
- **THEN** validation fails the block with reason `locator-out-of-range`

#### Scenario: A ragged column resolves

- **WHEN** an `artifact-table` reference names a column that only some rows hold
- **THEN** resolution returns the table

### Requirement: A reference resolves against a pinned snapshot

The harness MUST expose a `ReferenceResolver` seam. Its `resolve(reference,
snapshot)` operation MUST return the concrete value, or a typed
`UnresolvedReference`. The `reason` MUST be one of `artifact-missing`,
`hash-mismatch`, `locator-out-of-range`, `ambiguous-match`, or `assertion-failed`.
Resolution MUST target the pinned snapshot, so a version resolves to the same value
over time.

#### Scenario: A reference to a real cell resolves to its value

- **WHEN** a reference addresses a real cell in a pinned artifact
- **THEN** resolution returns the value at that cell

#### Scenario: A missing artifact returns artifact-missing

- **WHEN** a reference names a path that the snapshot does not hold
- **THEN** resolution returns an `UnresolvedReference` with reason `artifact-missing`

#### Scenario: A hash mismatch returns hash-mismatch

- **WHEN** a reference names a path whose content hash differs from the pinned `hash`
- **THEN** resolution returns an `UnresolvedReference` with reason `hash-mismatch`

#### Scenario: A locator past the last row returns locator-out-of-range

- **WHEN** a locator addresses a row or a cell that the artifact does not contain
- **THEN** resolution returns an `UnresolvedReference` with reason `locator-out-of-range`

### Requirement: An assertion is matched on resolve

An `assert` MUST carry a mandatory `value` and an optional `tolerance`. If a
reference carries an `assert`, resolution MUST read the artifact again and match the
resolved value within `tolerance`. A mismatch MUST return an `UnresolvedReference`
with reason `assertion-failed`. Thus a transcription error or a hallucinated number
fails even when the coordinate resolves.

A match on a numeral MUST compare the numeric value. It MUST NOT compare the storage
type of the cell. A text-backed artifact such as a CSV holds each cell as a string,
thus the cell `"0.01"` matches the authored number 0.01. A cell that does not read as
a finite number stays text, thus `"12 genes"` never matches 12.

With no `tolerance`, the match MUST absorb the noise of float arithmetic and nothing
more. Thus a computed 0.19999999999999998 matches an authored 0.2. An author who
wants a rounded figure to pass MUST state a `tolerance`.

A `citation` assert MUST carry a `value` that is text, and it MUST carry no
`tolerance`. The value is the prefixed `idKind:id` key, for example `pmid:12345`.
Resolution gives that key as text, thus a number could never match it.

An `assert` MUST carry no hash. An artifact reference already pins `hash`, and
resolution compares that pin against the fresh read. A second hash compares the
reference against itself, thus it adds no evidence.

Only a reference that resolves to one scalar MUST carry an `assert`. An
`artifact-table` and an `artifact-file` MUST carry none, because the pinned `hash` is
the only belief that an author can hold about the bytes.

#### Scenario: A correct assertion passes

- **WHEN** a reference carries an `assert.value` that equals the resolved value
- **THEN** resolution returns the value

#### Scenario: A wrong assertion fails

- **WHEN** a reference carries an `assert.value` that differs from the resolved value beyond `tolerance`
- **THEN** resolution returns an `UnresolvedReference` with reason `assertion-failed`

#### Scenario: An assert with a tolerance but no value is rejected

- **WHEN** a reference carries an `assert` that holds a `tolerance` and no `value`
- **THEN** validation rejects the reference, because the tolerance has nothing to compare against

#### Scenario: An assert on a whole-file reference is rejected

- **WHEN** an `artifact-table` or an `artifact-file` reference carries an `assert`
- **THEN** validation rejects the reference

#### Scenario: A numeric assert matches a text cell

- **WHEN** an artifact holds the cell `"0.01"` as text and a reference asserts the number 0.01
- **THEN** resolution matches the two and returns the value

#### Scenario: A cell that holds text never matches a number

- **WHEN** an artifact holds the cell `"12 genes"` and a reference asserts the number 12
- **THEN** resolution returns an `UnresolvedReference` with reason `assertion-failed`

#### Scenario: A rounded figure needs a tolerance

- **WHEN** a derivation computes 0.19999999999999998 and the reference asserts 0.19 with no `tolerance`
- **THEN** resolution returns an `UnresolvedReference` with reason `assertion-failed`

#### Scenario: A numeric citation assert is rejected

- **WHEN** a `citation` reference carries an `assert.value` that is a number
- **THEN** validation rejects the reference, because the resolved key is always text

### Requirement: Mechanical validation rejects fabrication

Mechanical validation MUST run these steps in order, schema conformance, binding
presence, resolution, and assertion match. A `claim` whose binding does not resolve
MUST fail validation. The validation MUST use no model. This is the mechanism that
prevents fabrication.

#### Scenario: A fully grounded report validates

- **WHEN** a report holds one of each block kind, and each binding resolves against the snapshot
- **THEN** mechanical validation accepts the report

#### Scenario: A claim with a non-resolving coordinate fails

- **WHEN** a `claim` binds to a coordinate that the snapshot does not resolve
- **THEN** mechanical validation fails the report with a typed `UnresolvedReference`

#### Scenario: A claim with a wrong asserted value fails

- **WHEN** a `claim` binds to a real coordinate but carries a wrong `assert.value`
- **THEN** mechanical validation fails the report with reason `assertion-failed`

### Requirement: A metric slot holds a reference, never a numeral

A `metric` value slot MUST hold a resolved reference, and it MUST NOT hold a numeric
literal. A numeral in `claim` or `text` prose outside a slot MUST raise a warning,
not a failure, because a natural-language numeral is brittle to enforce.

#### Scenario: A metric with a literal number is rejected

- **WHEN** a `metric` value slot holds a numeric literal instead of a reference
- **THEN** validation rejects the metric

#### Scenario: A free numeral in claim prose raises a warning

- **WHEN** a `claim` prose holds a numeral outside a bound slot
- **THEN** validation raises a warning and does not fail the report

### Requirement: A derived number is grounded two ways

The default MUST materialize a derived value as a hashed artifact, and the claim MUST
bind to a cell in that artifact. A `derivation` reference MUST be the escape hatch,
and it carries an `op` of `ratio`, `delta`, or `pctChange` and an `inputs` array.
Each input MUST be an `artifact-value` reference, the one kind that resolves to a
scalar. Thus a derivation cannot nest, and a table, a file, and a citation cannot sit
in an input. Validation MUST resolve each input, run the transform, then match the
assertion.

Over the inputs `a` and `b`, `ratio` MUST give `a / b` and `delta` MUST give
`a - b`. `pctChange` MUST give `(a - b) / b` as a fraction and not as a percent.
Thus a change of one half resolves to 0.5, and an `assert.value` states the
fraction.

#### Scenario: A materialize-first derived value validates

- **WHEN** a builder writes a derived value to a hashed artifact and a claim binds to that cell
- **THEN** validation resolves the cell and accepts the claim

#### Scenario: A derivation over grounded cells validates

- **WHEN** a `derivation` reference carries a ratio over two inputs that each resolve to a real cell
- **THEN** validation resolves the inputs, runs the ratio, and matches the assertion

#### Scenario: A derivation with a non-resolving input fails

- **WHEN** a `derivation` reference carries an input that does not resolve
- **THEN** validation fails the reference

#### Scenario: A derivation whose input is a derivation is rejected

- **WHEN** a `derivation` reference carries an input that is itself a `derivation`
- **THEN** validation rejects the reference, because a derivation cannot nest

#### Scenario: A derivation whose input resolves to no scalar is rejected

- **WHEN** a `derivation` reference carries an input that is an `artifact-table`, an `artifact-file`, or a `citation`
- **THEN** validation rejects the reference, because none of the three resolves to a scalar

#### Scenario: A derivation runs the arithmetic over text cells

- **WHEN** a `derivation` reference carries two inputs whose cells hold numerals as text
- **THEN** resolution reads each cell as a number and runs the transform

### Requirement: The reference serializes for cross-session transfer

The `Reference` MUST serialize to a compact JSON object, and to a canonical URI
string form for a carrier. It MUST carry no live object reference and no
session-local state. A later session MUST deserialize it and resolve it against the
same pinned snapshot to the same value.

#### Scenario: A reference round-trips through serialization

- **WHEN** a reference serializes to JSON and a later reader deserializes it
- **THEN** the deserialized reference equals the original

#### Scenario: A reference authored in one session resolves in another

- **WHEN** a reference authored in one session resolves in a second session against the same pinned snapshot
- **THEN** the second session reads the same value
