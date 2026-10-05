## MODIFIED Requirements

### Requirement: The eyes tool
The eyes tool MUST open the session page in headless Chrome, through the URL that the composition names. The URL seam of the composition maps the page of the thread onto the URL of one look. It receives the auth of the tool call beside the page identity. Thus a realization mints under the credential of the caller, and it holds no ambient state. Absent the seam, the tool MUST navigate through a `file://` URL of the page path. A throw of the seam MUST be a typed outcome, and no look runs.

The tool MUST give back the pictures, the coverage of the pictures, and the digest of the console errors and of the failed requests. A missed page MUST be a typed outcome. The tool MUST NOT block the loop on any judgment, because the judgment belongs to the agent.

The capture MUST settle the page before the screenshot, through reduced-motion emulation. The design source collapses each transition under that preference, thus the picture shows the final state and no mid-fade content.

The capture MUST lay out the page at the window of a reader, 1440 by 900 CSS pixels. It MUST render the pictures at a device scale of 0.5. A picture costs tokens in proportion to its area, thus the half scale lets one look hold a whole report. The pictures MUST show the whole document, and not the window alone. Thus a defect below the fold is visible, and the checklist is answerable.

The capture MUST measure the document height after the settle. A page of 4,000 CSS pixels or less MUST capture as one full-page shot. A taller page MUST capture as consecutive vertical slices of 4,000 CSS pixels, in document order. At the half scale, a slice is a picture of 720 by 2000 pixels. The model reads such a picture with no downscale, and a taller picture downscales or refuses the request.

A budget of 5 slices MUST bound one look, thus a look holds a maximum of 20,000 CSS pixels. A page taller than the budget MUST truncate, and the coverage MUST carry the captured pixels against the total. Nothing in the result says that such a look was whole.

The input of the tool can name one block id. The look MUST then capture that block alone. The renderer marks each block with its id (see the report-render capability). The capture MUST clip the union box of the marked elements, with a margin of 16 CSS pixels. A block taller than one slice MUST capture as slices under the same budget.

A page with no element of that id MUST give the outcome `no-block`, with no picture. A screenshot of a block that throws MUST be a failed capture with no retry. The window shows the top of the page, and not the block.

The result MUST name the coverage of the pictures as a discriminant:

- `full`: the whole page in one shot
- `tiled`: the slices, with the captured and the total pixels
- `viewport`: the window alone
- `block`: the one block, with the captured and the total pixels of its box

Each slice MUST carry its document range, and the look result MUST mirror those ranges in picture order. Thus the agent reads which rows each picture holds. The pictures MUST ride the image path of the tool result in document order, and the JSON text holds no bytes.

When a screenshot of the page throws, the capture MUST retry one time at the reader viewport. This applies to the full-page shot and to a slice. A partial look MUST still stamp the seen hash, because the agent saw the current document. A partial look is the viewport alone, slices that the budget truncated, or one block. Thus an oversized page degrades a look, and it never blocks the record path. The `no-block` outcome MUST stamp nothing, because no picture exists.

The tool MUST give the faults as a digest. A page that logs a blocked inline font can log its whole base64 body many times. Thus the raw lists can cost more context than the pictures. The digest MUST obey these rules:

- One entry with a count replaces each console error that occurs again, and each failed request that occurs again.
- A placeholder that gives the length replaces each inline data URI and each long base64 run.
- Each text stops at 300 code points.
- Each list stops at 20 different entries. A cut list carries the count of the entries that it left out.

The tool MUST reach the browser through the eyes seam of the composition. One look MUST acquire one lease, and the tool MUST release the lease after the look. The release runs on a pass and on a failed capture alike.

A failed release MUST NOT change the outcome of the look, and the log names the failed release. A failed acquire MUST be a typed outcome, and nothing throws.

An injected capture seam MUST win over the eyes seam, because it replaces the whole transport. A composition with no capture seam, no eyes seam, and no configured endpoint has no eyes. The tool MUST report that condition as a typed outcome, one time for each look.

#### Scenario: The eyes give the picture and the faults
- **WHEN** the eyes run after a preview
- **THEN** the result carries the pictures, the coverage, and the digest of the console errors and of the failed requests

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

#### Scenario: A slice renders at half scale
- **WHEN** the capture takes a slice of 4,000 CSS pixels
- **THEN** the picture of the slice is 720 by 2000 pixels

#### Scenario: A tall page arrives as slices
- **WHEN** the document height is more than 4,000 CSS pixels
- **THEN** the result carries consecutive slices in document order, each with its document range, and the coverage carries the captured and the total pixels

#### Scenario: A report of 16,000 pixels arrives whole
- **WHEN** the document height is 16,000 CSS pixels
- **THEN** the result carries 4 slices, and the coverage reports each pixel as captured

#### Scenario: A short page keeps the one shot
- **WHEN** the document height is 4,000 CSS pixels or less
- **THEN** the result carries one full-page picture, and the coverage names the whole page

#### Scenario: A page past the budget truncates honestly
- **WHEN** the document height is more than 20,000 CSS pixels
- **THEN** the slices stop at the budget, and the coverage reports fewer captured pixels than total pixels

#### Scenario: A block look holds the block alone
- **WHEN** the input names a block id that the page marks
- **THEN** the pictures hold the box of that block with its margin, and the coverage names `block`
- **AND** the seen stamp lands, the same as for a look at the whole page

#### Scenario: A tall block truncates at the budget
- **WHEN** the input names a block whose box is taller than 20,000 CSS pixels
- **THEN** the slices stop at the budget, and the `block` coverage reports fewer captured pixels than total pixels

#### Scenario: An unknown block gives no picture
- **WHEN** the input names a block id that no element of the page carries
- **THEN** the outcome is `no-block`, the result carries no picture, and the seen hash does not change

#### Scenario: A refused block screenshot is a failed capture
- **WHEN** a slice screenshot of a block look throws
- **THEN** the result carries the typed capture failure, and no retry at the viewport runs

#### Scenario: The digest collapses a fault that occurs again
- **WHEN** the page logs one console error that holds an inline font 30 times
- **THEN** the digest carries one entry with the count 30, and a placeholder replaces the font data

#### Scenario: A failed full-page capture degrades to the viewport
- **WHEN** the full-page screenshot throws and the viewport screenshot passes
- **THEN** the result carries the viewport picture, the coverage names the viewport, and the seen stamp lands

#### Scenario: A failed slice capture degrades to the viewport
- **WHEN** a slice screenshot of the page throws and the viewport screenshot passes
- **THEN** the result carries the viewport picture, the coverage names the viewport, and the seen stamp lands

#### Scenario: A failed viewport retry stays a failed capture
- **WHEN** the full-page screenshot throws and the viewport retry also throws
- **THEN** the result carries the typed capture failure, exactly as before

#### Scenario: A truncated look still stamps
- **WHEN** a sliced look reports fewer captured pixels than total pixels
- **THEN** the seen stamp lands, and the coverage tells the agent what it saw

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
