## ADDED Requirements

### Requirement: A box series with no group carries no name
The derived option of a box chart with no `group` channel MUST give no `name` to its box series and to its outlier series.

A series name shows in the tooltip header and in a legend. A box with no group has one lane, and that lane has no group value to name. Thus a name for it would show text that no row holds, for example `undefined`.

#### Scenario: An ungrouped box has no series name
- **WHEN** the caller renders a box chart with no `group` channel
- **THEN** the box series and the outlier series of the option carry no `name` value

#### Scenario: A grouped box names each series by its group
- **WHEN** the caller renders a box chart with a `group` channel of two conditions
- **THEN** the box series of each group carries the name of its group
