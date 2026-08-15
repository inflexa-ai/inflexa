# Delta: report-render

## MODIFIED Requirements

### Requirement: The page navigation
The page MUST hold a left-side navigation with one anchor for each top-level section. Each anchor MUST target its section by the section block id.

The page script MUST highlight the anchor of the section in view, through an observer over the section anchors and with no dependency. One anchor is active at a time. A browser without the observer keeps the plain links, because the highlight is decoration.

#### Scenario: The navigation lists the top-level sections
- **WHEN** the caller renders a document with three top-level sections
- **THEN** the navigation holds three anchors, and each anchor targets its section id

#### Scenario: The page carries the scrollspy script
- **WHEN** the caller renders a document with sections
- **THEN** the page script observes the section anchors, and it drives one active class on the matching link

### Requirement: The claim evidence renders as markers and a provenance appendix
A claim MUST render its prose with evidence markers. The references MUST list at the end of the page under the title "Data provenance", styled as a muted appendix. The literature renders from citation blocks, and it stays separate from the appendix. The markers number by first appearance. An identical reference MUST appear one time in the list. Reference identity is the full reference value after a stable serialization, thus two references are identical only when every field matches. A derivation reference MUST list as its operation with its two pinned inputs, each named by path and locator.

#### Scenario: Two claims share one reference
- **WHEN** the caller renders two claim blocks that carry the same reference
- **THEN** both claims show the same marker number, and the list holds one entry for it

#### Scenario: The appendix wears the provenance title
- **WHEN** the caller renders a document with a claim
- **THEN** the list at the end of the page is titled "Data provenance", and no auto-generated surface is titled "References"

## RENAMED Requirements

- FROM: `### Requirement: The claim evidence renders as markers and a reference list`
- TO: `### Requirement: The claim evidence renders as markers and a provenance appendix`
