## MODIFIED Requirements

### Requirement: Global extensions are tested
The suite SHALL verify the `src/extensions/*` methods: `JSON.parseWith` (null on parse-throw and on
schema-mismatch), `Response.prototype.jsonWith`, `Date.relativeAge` (s/m/h/d buckets and negative
clamp to `0s`), `Promise.sleep` (under fake timers), and `Number.prototype.formatBytes` (unit
boundaries across `B`/`KB`/`MB`/`GB` on a 1024 base, and negative or non-finite input clamped to a
zero-byte reading rather than `NaN`).

#### Scenario: parseWith fails closed
- **WHEN** `JSON.parseWith` receives malformed JSON or JSON failing the schema
- **THEN** it returns `null` rather than throwing

#### Scenario: relativeAge negative clamp
- **WHEN** `Date.relativeAge` is given a future timestamp
- **THEN** it returns `"0s"` (clamped), not a negative value

#### Scenario: formatBytes unit boundaries
- **WHEN** `Number.prototype.formatBytes` is called at and around each unit boundary
- **THEN** values below 1024 read as whole bytes and larger ones read as one decimal of the largest
  fitting unit, each unit stepping at 1024 of the one below it

#### Scenario: formatBytes clamps unusable input
- **WHEN** `Number.prototype.formatBytes` is called on a negative or non-finite number
- **THEN** it returns a zero-byte reading rather than a negative or `NaN` string
