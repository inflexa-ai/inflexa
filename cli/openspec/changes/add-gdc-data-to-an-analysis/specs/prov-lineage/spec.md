## ADDED Requirements

### Requirement: Backward lineage ends at the source of a downloaded file

A backward walk from a downloaded file MUST pass the `inflexa:AcquireInput`
action, and it MUST end at the source node. The tree MUST show the action
with the source name and the release. It MUST show the source node with its
source identifier and its source digest. The source node is a terminal node.
The JSON, dot, and mermaid renders MUST carry the source node. A staged file
with no download MUST render as a terminal input, as before.

#### Scenario: A step output walks back to the GDC

- **GIVEN** a step that read a downloaded file and wrote `de_results.csv`
- **WHEN** lineage is asked for `de_results.csv`
- **THEN** the tree shows the step read, and then the `AcquireInput` action
  with the source `GDC` and its release
- **AND** the walk ends at the source node, with the file UUID

#### Scenario: The JSON render carries the source node

- **WHEN** `--format json` renders a walk that reaches a source node
- **THEN** the node carries the kind `source`, the source identifier, the
  URL, the release, and the source digest

#### Scenario: A local input does not change

- **WHEN** a backward walk reaches a staged file that no download made
- **THEN** the file renders as a terminal input, as before this change
