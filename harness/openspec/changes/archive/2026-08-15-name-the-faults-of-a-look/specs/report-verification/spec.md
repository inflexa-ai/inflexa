# Delta: report-verification

## MODIFIED Requirements

### Requirement: The eyes tool
The eyes tool MUST open the session page through a `file://` navigation of headless Chrome. It MUST give back the screenshot, the console errors, and the failed requests. A missed page MUST be a typed outcome. The tool MUST NOT block the loop on any judgment, because the judgment belongs to the agent.

The capture MUST settle the page before the screenshot, through reduced-motion emulation. The design source collapses each transition under that preference, thus the picture shows the final state and no mid-fade content. The capture MUST show the whole page at a reader viewport, thus a defect below the fold is visible and the checklist is answerable.

The tool MUST reach the browser through the eyes seam of the composition. One look MUST acquire one lease, and the tool MUST release the lease after the look. The release runs on a pass and on a failed capture alike.

A failed release MUST NOT change the outcome of the look, and the log names the failed release. A failed acquire MUST be a typed outcome, and nothing throws.

An injected capture seam MUST win over the eyes seam, because it replaces the whole transport. A composition with no capture seam, no eyes seam, and no configured endpoint has no eyes. The tool MUST report that condition as a typed outcome, one time for each look.

#### Scenario: The capture settles the page
- **WHEN** the capture navigates to a page with reveal transitions
- **THEN** the emulated reduced-motion preference is active before the navigation, and the screenshot shows the settled state
