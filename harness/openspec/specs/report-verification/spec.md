# report-verification Specification

## Purpose

Define the gate that stands before a recorded report version, and the eyes of the
builder loop. The gate is the guarantee against fabrication: a claim that binds a
real coordinate and states a wrong number fails here, and no model judgment joins
the rule.

The version store is append-only, thus the gate runs first, and a version that the
gate did not accept never exists. The eyes give the agent a look at the rendered
page, and the look-before-record rule makes the look a mechanical precondition. The
visual judgment itself stays with the agent, and it stays advisory.

## Requirements

### Requirement: The gate runs before the store
The record tool MUST run the full validation before `store.record`. The validation MUST cover the finish, the resolution of every reference, the chart-encoding match, and the assert match. Only a pass MUST reach the store. Thus a version that the gate did not accept never exists. The record MUST write the document value that the gate validated. The one-per-thread rule of the store bounds a concurrent race.

#### Scenario: A failed gate records nothing
- **WHEN** one reference of the document fails its assert
- **THEN** the record refuses, and the store holds no new row

#### Scenario: A pass records one version
- **WHEN** the gate passes and the thread holds no version
- **THEN** the store records the version, and the tool gives the version id

### Requirement: A failure names its block
Each gate failure MUST carry the `id` of the block that holds the failed part. Thus the agent repairs one block, and not the report at large.

#### Scenario: The failure carries the block id
- **WHEN** the metric block `m1` fails its assert
- **THEN** the failure names `m1` and the reason

### Requirement: The look-before-record rule
The record MUST refuse until the eyes ran against the current document state. The preview stamps the hash of the rendered document, under the render-and-preview requirement. The eyes MUST copy that stamp as the seen hash. The record MUST compare the seen hash against the current document, and a mismatch MUST refuse. The rule MUST read no model judgment.

#### Scenario: A never-seen page cannot record
- **WHEN** the gate passes and no eyes ran on the current document
- **THEN** the record refuses with a typed reason, and the store holds no new row

#### Scenario: A stale look does not count
- **WHEN** the eyes ran, and the agent then changed a block
- **THEN** the record refuses until a new preview and a new look run

### Requirement: The eyes tool
The eyes tool MUST open the session page through a `file://` navigation of headless Chrome. It MUST give back the screenshot, the console errors, and the failed requests. A missed page MUST be a typed outcome. The tool MUST NOT block the loop on any judgment, because the judgment belongs to the agent.

#### Scenario: The eyes give the picture and the faults
- **WHEN** the eyes run after a preview
- **THEN** the result carries the screenshot, the console errors, and the failed requests

#### Scenario: No page is a typed outcome
- **WHEN** the eyes run before any preview
- **THEN** the result says that no page exists, and nothing throws
