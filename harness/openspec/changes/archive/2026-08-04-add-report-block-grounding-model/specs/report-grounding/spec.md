## ADDED Requirements

### Requirement: A reference is one canonical shape

The harness MUST define one `Reference` object, and every evidentiary block MUST
carry it. A reference MUST carry a `kind` of `artifact-value`, `artifact-table`,
`artifact-file`, `derivation`, or `citation`. An artifact reference MUST pin `run`,
`path`, and `hash`, and it can carry a `snapshot`. It can carry an `assert`, a
`unit`, and a `format`. The reference MUST reuse the coordinates that the harness
already keys on, the run id `cortex_runs.run_id` and the file key
`cortex_artifacts(path, hash)`.

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

If a reference carries an `assert.value` or an `assert.hash`, resolution MUST
re-read the artifact and match the resolved value within `tolerance`. A mismatch
MUST return an `UnresolvedReference` with reason `assertion-failed`. Thus a
transcription error or a hallucinated number fails even when the coordinate
resolves.

#### Scenario: A correct assertion passes

- **WHEN** a reference carries an `assert.value` that equals the resolved value
- **THEN** resolution returns the value

#### Scenario: A wrong assertion fails

- **WHEN** a reference carries an `assert.value` that differs from the resolved value beyond `tolerance`
- **THEN** resolution returns an `UnresolvedReference` with reason `assertion-failed`

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
Each input MUST be a non-derivation reference that resolves, so a derivation cannot
nest. Validation MUST resolve each input, run the transform, then match the
assertion.

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
