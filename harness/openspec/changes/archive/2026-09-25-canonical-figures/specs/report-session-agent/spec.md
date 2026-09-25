# Spec Delta

## MODIFIED Requirements

### Requirement: The figure is the last choice
The prompt MUST state that a figure block is the last choice, for a picture that no table can carry. It MUST name the permitted uses: a microscopy image, a schematic, and a genome browser track. It MUST state that each other plot of a run is a chart block over the table that made it. It MUST refer to the block schema of `add_block` for the chart types and the presets. It MUST NOT keep a list of plots of its own.

The "Do NOT" list MUST name the run figure of such a plot as a fault. The figure block carries no reason field, thus the rule lives in the prompt and in the look checklist alone.

#### Scenario: The prompt carries the figure-last rule
- **WHEN** a reviewer reads the prompt module
- **THEN** the permitted figure uses and the reference to the block schema are present, and the "Do NOT" list names the run figure of a plot

#### Scenario: The prompt keeps no list of chart plots
- **WHEN** a reviewer reads the figure-last paragraph
- **THEN** the paragraph names no plot type, and the block schema stays the one list of the presets

## ADDED Requirements

### Requirement: The prompt teaches the preset, the statistics, and the track
The prompt MUST hold one paragraph that teaches three rules:

- A plot of a field takes its preset, and the preset draws the canonical figure of that field from one table.
- A statistic that the figure prints binds as a statistic of the chart block, and each statistic reads one cell of the pinned evidence.
- A second table that the figure draws beside its table binds as the track of the chart block.

The paragraph MUST name no dataset and no preset list, because the block schema carries the presets and their channels. It MUST state no numeric anchor.

#### Scenario: The prompt carries the preset paragraph
- **WHEN** a reviewer reads the prompt module
- **THEN** one paragraph teaches the preset, the statistic of the chart block, and the track of the chart block

#### Scenario: The paragraph names no data
- **WHEN** a reviewer reads the preset paragraph
- **THEN** the paragraph holds no dataset name and no numeral
