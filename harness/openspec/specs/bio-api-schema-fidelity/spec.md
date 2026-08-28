# bio-api-schema-fidelity Specification

## Purpose

Each external-API client validates its responses with a zod schema. This capability fixes the contract for those schemas: a schema mirrors the truth of its endpoint, with evidence. A live audit of all 30 clients (2026-08) showed the two failure classes that this contract prevents. An over-strict schema rejects a real payload, and the tool call fails. A dead or misplaced field gives wrong or empty data in silence. The golden fixtures under `src/tools/lib/__fixtures__/` hold the evidence, and the `integration-tests-external-api` spec carries the test tiers.

## Requirements

### Requirement: External-API response schemas mirror endpoint evidence

The zod schema of an external-API client MUST mirror the published machine schema of the provider. When no published schema exists, the zod schema MUST mirror the sampled wire truth that the golden fixtures hold. A field modifier MUST NOT widen without evidence.

#### Scenario: A published nullable field accepts the explicit null

- **WHEN** the published schema of the provider marks a field as nullable, as ChEMBL marks `pref_name`
- **THEN** the zod field carries `.nullable()`, and a real payload with the explicit `null` parses

#### Scenario: A Tastypie decimal parses as a wire number

- **WHEN** ChEMBL serves `max_phase` as the JSON string `"4.0"`
- **THEN** the schema accepts the string, and the mapped output value is the number 4

#### Scenario: No evidence gives no widening

- **WHEN** no published schema and no sampled payload shows a `null` or an omission for a field
- **THEN** the field keeps its strict modifier, and the negative fixture of the schema still fails to parse

### Requirement: Each client obeys the absence policy of its provider

Each provider encodes an absent value in one constant way: an explicit `null`, an omitted key, an empty string, or the nullability of its GraphQL SDL. Each client schema MUST encode the policy of its provider, and a comment at the top of the client MUST name that policy.

#### Scenario: ChEMBL absence is an explicit null

- **WHEN** a ChEMBL payload carries `null` for an absent value, and the key is present
- **THEN** the schema parses the payload, because the affected fields carry `.nullable()`

#### Scenario: PubChem absence is an omitted key

- **WHEN** a PubChem payload omits the key of an absent value, as it omits `XLogP` for a salt
- **THEN** the schema parses the payload, because the affected fields carry `.optional()`

#### Scenario: A GraphQL field obeys the SDL

- **WHEN** DGIdb serves an explicit `null` for a field that its SDL marks as nullable
- **THEN** the schema parses the response, because the declared modifier comes from the SDL

### Requirement: A string-serialized number goes through the shared wire-number helper

A numeric field that a provider serializes as a JSON string MUST go through the one shared helper in `api-utils.ts`. The helper accepts `string | number | null`, and it gives `number | null`. A value that does not parse gives `null`.

#### Scenario: A quoted decimal becomes a number

- **WHEN** the wire value is the string `"4.0"`
- **THEN** the mapped output value is the number 4

#### Scenario: A real number passes through

- **WHEN** the wire value is the number 2001
- **THEN** the mapped output value is the number 2001

#### Scenario: A non-numeric string becomes null

- **WHEN** the wire value is a string that does not parse as a number
- **THEN** the mapped output value is `null`

### Requirement: A schema declares only fields that the provider contract carries

A schema MUST NOT declare a field that the provider does not serve at that level and under that name. A dead field MUST be deleted. A wrong-name field MUST take the wire name. A wrong-level field MUST move to its real level.

#### Scenario: A golden fixture proves that each mapped field carries data

- **WHEN** the table-driven test parses the positive golden fixture of a schema
- **THEN** each mapped output field that the fixture carries on the wire is not `null`

#### Scenario: A renamed wire key feeds the mapped output

- **WHEN** the ChEMBL compound schema reads the molecular formula
- **THEN** the value comes from the wire key `full_molformula`, and the mapped output for a small molecule is not `null`

### Requirement: An unverified contract carries a marker

A client whose provider cannot be verified without a key MUST carry a file-top comment that marks the contract as unverified. The marker MUST name the date and the evidence source. The schema of such a client MUST stay conservative, and it MUST reject a payload that is not a data record.

#### Scenario: A key-blocked client is marked

- **WHEN** a reviewer opens the DrugBank client
- **THEN** the file-top comment names the unverified status, the date, and the secondary evidence

#### Scenario: An error envelope does not become a blank record

- **WHEN** the DrugBank endpoint answers with an error envelope, for example `{"error": "Key invalid"}`
- **THEN** the response schema rejects the envelope, and the caller sees `invalid_response`, not one blank drug row

### Requirement: A silent degradation site reports the unexpected cause

A call site that converts an error into an empty result MUST report an unexpected cause through the injected `Logger` before it degrades. An expected miss, such as an HTTP 404, MUST degrade in silence.

#### Scenario: A schema rejection is reported before the degrade

- **WHEN** a lookup inside the target-assessment collectors receives `invalid_response`, and the site degrades to an empty list
- **THEN** the site writes one `Logger` error record with the cause before it returns the empty list

#### Scenario: An expected miss stays silent

- **WHEN** the same lookup receives an HTTP 404 for an unknown identifier
- **THEN** the site returns the empty result and writes no error record
