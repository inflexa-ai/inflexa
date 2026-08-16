# Delta: report-verification

## MODIFIED Requirements

### Requirement: The eyes tool

The capture MUST retry one time at the reader viewport when the full-page screenshot throws. The result MUST name the coverage of the picture: the whole page, or the viewport alone. A viewport look MUST still stamp the seen hash, because the agent saw the current document. Thus an oversized page degrades a look, and it never blocks the record path.

#### Scenario: A failed full-page capture degrades to the viewport

- **WHEN** the full-page screenshot throws and the viewport screenshot passes
- **THEN** the result carries the viewport picture, the coverage names the viewport, and the seen stamp lands

#### Scenario: A failed viewport retry stays a failed capture

- **WHEN** the full-page screenshot throws and the viewport retry also throws
- **THEN** the result carries the typed capture failure, exactly as before
