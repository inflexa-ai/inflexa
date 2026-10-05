# Delta: report-verification

## MODIFIED Requirements

### Requirement: The eyes tool
The eyes tool MUST open the session page in headless Chrome, through the URL that the composition names. The URL seam of the composition maps the page of the thread onto the URL of one look, and it receives the auth of the tool call beside the page identity — a realization mints under the credential of the caller, and it holds no ambient state. Absent the seam, the tool MUST navigate through a `file://` URL of the page path. A throw of the seam MUST be a typed outcome, and no look runs. The tool MUST give back the screenshot, the console errors, and the failed requests. A missed page MUST be a typed outcome. The tool MUST NOT block the loop on any judgment, because the judgment belongs to the agent.

The capture MUST settle the page before the screenshot, through reduced-motion emulation. The design source collapses each transition under that preference, thus the picture shows the final state and no mid-fade content. The capture MUST show the whole page at a reader viewport, thus a defect below the fold is visible and the checklist is answerable.

The capture MUST measure the document height after the settle. A page at the single-shot bound or under MUST capture as one full-page shot. A taller page MUST capture as consecutive vertical slices in document order, each about two reader-window heights, because the provider path rejects a picture past its dimension cap and downscales a tall legal picture past legibility. A slice budget MUST bound the count, and a page taller than the budget covers MUST truncate honestly: the coverage carries the captured pixels against the total, and nothing pretends the look was whole.

The result MUST name the coverage of the pictures as a discriminant: the whole page in one shot, the tiled slices with the captured and the total pixels, or the viewport alone. Each slice MUST carry its document range, and the look result MUST mirror those ranges in picture order, thus the agent reads which rows each picture holds. The slices MUST ride the image path of the tool result in document order.

The capture MUST retry one time at the reader viewport when a screenshot throws, for the full-page shot and for a slice alike. A partial look — the viewport alone, or slices that the budget truncated — MUST still stamp the seen hash, because the agent saw the current document. Thus an oversized page degrades a look, and it never blocks the record path.

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

#### Scenario: A bound URL seam names the served page
- **WHEN** the composition binds the URL seam and a look runs
- **THEN** the navigation opens the URL that the seam gave, and no `file://` URL forms

#### Scenario: A failed URL formation is a typed outcome
- **WHEN** the bound URL seam throws
- **THEN** the result carries the typed capture failure, and no look runs

#### Scenario: A failed full-page capture degrades to the viewport

- **WHEN** the full-page screenshot throws and the viewport screenshot passes
- **THEN** the result carries the viewport picture, the coverage names the viewport, and the seen stamp lands

#### Scenario: A failed viewport retry stays a failed capture

- **WHEN** the full-page screenshot throws and the viewport retry also throws
- **THEN** the result carries the typed capture failure, exactly as before

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

#### Scenario: A tall page arrives as slices

- **WHEN** the document height passes the single-shot bound
- **THEN** the result carries consecutive slices in document order, each with its document range, and the coverage carries the captured and the total pixels

#### Scenario: A short page keeps the one shot

- **WHEN** the document height sits at the single-shot bound or under
- **THEN** the result carries one full-page picture, and the coverage names the whole page

#### Scenario: A page past the budget truncates honestly

- **WHEN** the document height passes what the slice budget covers
- **THEN** the slices stop at the budget, and the coverage reports fewer captured pixels than total pixels

#### Scenario: A failed slice capture degrades to the viewport

- **WHEN** a slice screenshot throws and the viewport screenshot passes
- **THEN** the result carries the viewport picture, the coverage names the viewport, and the seen stamp lands

#### Scenario: A truncated look still stamps

- **WHEN** a tiled look reports fewer captured pixels than total pixels
- **THEN** the seen stamp lands, and the coverage is what tells the agent what it saw
