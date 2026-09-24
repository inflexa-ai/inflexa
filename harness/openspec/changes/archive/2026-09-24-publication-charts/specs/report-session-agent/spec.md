# Spec Delta

## ADDED Requirements

### Requirement: The figure is the last choice
The prompt MUST state that a figure block is the last choice, for a picture that no table can carry. It MUST name the permitted uses: a microscopy image, a schematic, and a genome browser track. It MUST name the plots that are chart blocks over the table that made them: a volcano, a heatmap, a dot plot, a violin, an embedding, a forest plot, a stacked composition, and a radar. The "Do NOT" list MUST name the run figure of such a plot as a fault. The figure block carries no reason field, thus the rule lives in the prompt and in the look checklist alone.

#### Scenario: The prompt carries the figure-last rule
- **WHEN** a reviewer reads the prompt module
- **THEN** the permitted figure uses and the named chart plots are present, and the "Do NOT" list names the run figure of a plot
