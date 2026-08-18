# Delta: report-session-agent

## MODIFIED Requirements

### Requirement: The prompt obligations

The prompt MUST teach the sliced look. A tall page arrives as consecutive top-to-bottom slices of the same page, in document order, and the agent reads the slices as one page. The prompt MUST state plainly that a truncated coverage — fewer captured pixels than total pixels — means the tail of the page was not seen: absent from the look, and not from the page. The prompt MUST state that only a whole look — one full shot, or slices that captured every pixel — makes an unseen section a real fault; under a partial look the agent judges what the pictures show and leaves the rest of the draft as it stands.

#### Scenario: The prompt teaches the sliced look

- **WHEN** a reviewer reads the prompt module
- **THEN** the sliced look reads as one page in document order, and a truncated coverage names the unseen tail as absent from the look and not from the page
