## ADDED Requirements

### Requirement: An empty graphic list is not an annotation for the grid top
The grid default MUST read an empty `graphic` list as no annotation. Thus the default `top` of a cartesian chart stays `"8%"`.

A figure can give an empty `graphic` list when it has no statistics or no key to draw. An empty list draws nothing, thus it does not share the canvas with the plot.

#### Scenario: An empty graphic list keeps the default top
- **WHEN** a cartesian spec with no authored `grid.top` and a `graphic` member that is an empty list is normalized
- **THEN** `grid.top` is `"8%"`

#### Scenario: A graphic element moves the top down
- **WHEN** a cartesian spec with no authored `grid.top` and a `graphic` list of one text element is normalized
- **THEN** `grid.top` is `"12%"`
