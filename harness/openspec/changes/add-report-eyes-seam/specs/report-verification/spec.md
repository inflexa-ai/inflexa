## ADDED Requirements

### Requirement: The eyes seam
The composition MUST give the eyes through one provisioning seam. The acquire operation takes a scope and returns a lease. The scope carries the analysis id and the workspace root, thus a realization can mount the root for a `file://` navigation. The lease carries a browser endpoint and a release operation.

The seam owns provisioning alone. The page behavior stays in the harness: the navigation, the readiness wait, and the seen stamp.

A realization MUST bound the life of what it provisions. A lease that no release ends MUST still end at that bound. Thus a crash between the acquire and the release leaks nothing.

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

## MODIFIED Requirements

### Requirement: The eyes tool
The eyes tool MUST open the session page through a `file://` navigation of headless Chrome. It MUST give back the screenshot, the console errors, and the failed requests. A missed page MUST be a typed outcome. The tool MUST NOT block the loop on any judgment, because the judgment belongs to the agent.

The tool MUST reach the browser through the eyes seam of the composition. One look MUST acquire one lease, and the tool MUST release the lease after the look. The release runs on a pass and on a failed capture alike.

A failed release MUST NOT change the outcome of the look, and the log names the failed release. A failed acquire MUST be a typed outcome, and nothing throws.

An injected capture seam MUST win over the eyes seam, because it replaces the whole transport. A composition with no capture seam, no eyes seam, and no configured endpoint has no eyes. The tool MUST report that condition as a typed outcome, one time for each look.

#### Scenario: The eyes give the picture and the faults

- **WHEN** the eyes run after a preview
- **THEN** the result carries the screenshot, the console errors, and the failed requests

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
