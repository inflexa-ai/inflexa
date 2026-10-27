# Spec Delta

## ADDED Requirements

### Requirement: A byte-level form of the subsequence scorer

The scorer MUST give a byte-level form that scores a lower-case ASCII query against a range of UTF-8 bytes. The range is a name inside a shared byte pool. For a name whose bytes are all ASCII, the form MUST give the score of the string scorer for the same query and name. It folds the ASCII upper-case letters of the name to lower case. It MUST import nothing from `src/tui/`, `src/modules/`, or `src/db/`.

A caller MUST use the string scorer for a name that holds a byte outside ASCII. Thus the two forms agree on each name.

#### Scenario: The two forms agree on an ASCII name

- **WHEN** the byte form scores `volc` against the bytes of `Volcano.png`
- **THEN** the score is the score of the string form for `volc` and `Volcano.png`

#### Scenario: A non-subsequence is rejected

- **WHEN** the byte form scores `zx` against the bytes of `tokyo-night`
- **THEN** the score is `-1`

#### Scenario: An empty query is neutral

- **WHEN** the byte form scores an empty query against a name
- **THEN** the score is `0`
