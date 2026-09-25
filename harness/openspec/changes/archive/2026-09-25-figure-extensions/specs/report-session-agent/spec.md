## MODIFIED Requirements

### Requirement: The prompt teaches the preset, the statistics, and the track
The prompt MUST hold one paragraph that teaches four rules:

- A plot of a field takes its preset, and the preset draws the canonical figure of that field from one table.
- A statistic that the figure prints binds as a statistic of the chart block, and each statistic reads one cell of the pinned evidence.
- A second table that the figure draws beside its table binds as the track of the chart block.
- When a clustering orders an axis of a heatmap, its edge table binds as the tree of that axis. The axis takes the leaf order of the tree.

The paragraph MUST name no dataset and no preset list, because the block schema carries the presets and their channels. It MUST state no numeric anchor.

#### Scenario: The prompt carries the preset paragraph
- **WHEN** a reviewer reads the prompt module
- **THEN** one paragraph teaches the preset, the statistic of the chart block, the track of the chart block, and the tree of a clustered axis

#### Scenario: The paragraph names no data
- **WHEN** a reviewer reads the preset paragraph
- **THEN** the paragraph holds no dataset name and no numeral
