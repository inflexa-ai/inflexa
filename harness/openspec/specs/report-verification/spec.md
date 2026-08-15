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

### Requirement: The eyes seam
The composition MUST give the eyes through one provisioning seam. The acquire operation takes a scope and returns a lease. The scope carries the analysis id and the workspace root, thus a realization can mount the root for a `file://` navigation. The lease carries a browser endpoint and a release operation.

The seam owns provisioning alone. The page behavior stays in the harness: the navigation, the readiness wait, and the seen stamp.

A realization MUST bound the life of what it provisions. A lease that no release ends MUST still end at that bound. Thus a crash between the acquire and the release leaks nothing.

A realization MUST bound how many browsers it provisions at one time. The page gate of the harness bounds one endpoint. Thus a realization that starts a browser at a new endpoint for each look meets no harness-side bound. Only the realization knows its own resource, and the count bound sits there.

The harness MUST ship the static realization over a standing sidecar. It returns the configured endpoint, and its release does nothing. The assembly MUST wrap a configured browser endpoint into the static realization. Thus a composition that names a standing sidecar changes nothing.

#### Scenario: The static realization gives the configured endpoint

- **WHEN** the composition names a standing sidecar endpoint and the seam is the static realization
- **THEN** the acquire gives that endpoint, and the release does nothing

#### Scenario: The assembly wraps a configured endpoint

- **WHEN** the composition binds no eyes seam and the chrome config names a browser
- **THEN** the assembled report agent holds the static realization over that endpoint

#### Scenario: The scope carries what a realization mounts

- **WHEN** a realization reads the scope of one acquire
- **THEN** the scope holds the analysis id and the workspace root of that analysis

#### Scenario: A lost release leaks nothing

- **WHEN** a lease is acquired and no release ever runs
- **THEN** the provisioned browser ends at the bound of the realization

#### Scenario: A realization bounds the count of its browsers

- **WHEN** a realization starts a browser at a new endpoint for each look
- **THEN** the realization bounds how many of those browsers run at one time

### Requirement: The eyes tool
The eyes tool MUST open the session page through a `file://` navigation of headless Chrome. It MUST give back the screenshot, the console errors, and the failed requests. A missed page MUST be a typed outcome. The tool MUST NOT block the loop on any judgment, because the judgment belongs to the agent.

The capture MUST settle the page before the screenshot, through reduced-motion emulation. The design source collapses each transition under that preference, thus the picture shows the final state and no mid-fade content. The capture MUST show the whole page at a reader viewport, thus a defect below the fold is visible and the checklist is answerable.

The tool MUST reach the browser through the eyes seam of the composition. One look MUST acquire one lease, and the tool MUST release the lease after the look. The release runs on a pass and on a failed capture alike.

A failed release MUST NOT change the outcome of the look, and the log names the failed release. A failed acquire MUST be a typed outcome, and nothing throws.

An injected capture seam MUST win over the eyes seam, because it replaces the whole transport. A composition with no capture seam, no eyes seam, and no configured endpoint has no eyes. The tool MUST report that condition as a typed outcome, one time for each look.

#### Scenario: The eyes give the picture and the faults
- **WHEN** the eyes run after a preview
- **THEN** the result carries the screenshot, the console errors, and the failed requests

#### Scenario: The capture settles the page
- **WHEN** the capture navigates to a page with reveal transitions
- **THEN** the emulated reduced-motion preference is active before the navigation, and the screenshot shows the settled state

#### Scenario: No page is a typed outcome
- **WHEN** the eyes run before any preview
- **THEN** the result says that no page exists, and nothing throws

#### Scenario: One look releases its lease

- **WHEN** the eyes run one look through the eyes seam
- **THEN** the tool acquires one lease, and the lease is released after the look

#### Scenario: A failed capture still releases

- **WHEN** the capture throws after the acquire
- **THEN** the tool releases the lease, and the result carries the typed capture failure

#### Scenario: A failed release keeps the look

- **WHEN** the capture passes and the release throws
- **THEN** the result carries the capture, and the log names the failed release

#### Scenario: A failed acquire is a typed outcome

- **WHEN** the acquire throws
- **THEN** the result carries the typed capture failure with the detail, and nothing throws

#### Scenario: A composition with no eyes reports the condition

- **WHEN** the composition binds no capture seam, no eyes seam, and no browser endpoint
- **THEN** the tool reports the no-browser condition as a typed outcome
