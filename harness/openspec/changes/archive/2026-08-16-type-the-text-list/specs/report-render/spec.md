# Delta: report-render

## MODIFIED Requirements

### Requirement: A rendered form for each block kind

A text block with a list MUST render the list after its prose paragraphs, as ordered or unordered list markup by the flag. Each item escapes exactly as a paragraph does, and the list fills the content column. A text block with a list and an empty prose renders the list alone.

#### Scenario: An enumeration renders as a list

- **WHEN** the caller renders a text block with a lead sentence and six ordered items
- **THEN** the page holds the paragraph and an ordered list with the six items

#### Scenario: A list stands alone

- **WHEN** the caller renders a text block with an empty prose and three unordered items
- **THEN** the page holds the unordered list, and no empty paragraph
