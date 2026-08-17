# Delta: report-verification

## MODIFIED Requirements

### Requirement: The eyes tool

The eyes tool MUST open the session page in headless Chrome, through the URL that the composition names. The URL seam of the composition maps the page of the thread onto the URL of one look, and it receives the auth of the tool call beside the page identity — a realization mints under the credential of the caller, and it holds no ambient state. Absent the seam, the tool MUST navigate through a `file://` URL of the page path. A throw of the seam MUST be a typed outcome, and no look runs.

#### Scenario: A bound URL seam names the served page
- **WHEN** the composition binds the URL seam and a look runs
- **THEN** the navigation opens the URL that the seam gave, and no `file://` URL forms

#### Scenario: A failed URL formation is a typed outcome
- **WHEN** the bound URL seam throws
- **THEN** the result carries the typed capture failure, and no look runs
