# Delta: report-block-model

## MODIFIED Requirements

### Requirement: A content grammar constrains nesting

The text block MUST admit an optional typed list beside its prose: an ordered flag, and an items array of non-empty inline lines, with at least one item. The list is content, not markup, and no markdown joins. A text block with a list and an empty prose is valid content.

#### Scenario: A text block carries a list

- **WHEN** a text block carries six ordered limitation items beside a lead sentence
- **THEN** the block validates, and the list rides the stored document

#### Scenario: An empty list refuses

- **WHEN** a text block carries a list with zero items
- **THEN** the parse fails
