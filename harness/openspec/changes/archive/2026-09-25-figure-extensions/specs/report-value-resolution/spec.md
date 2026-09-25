## MODIFIED Requirements

### Requirement: A chart resolves each of its references
The resolution pass MUST resolve each reference of a chart block: the binding, the track, the tree of each axis, and each statistic. The block walk MUST give each reference of a chart a slot: `binding`, `track`, `tree:x`, `tree:y`, or `statistic:N`, where N is the place of the statistic in the block. The walk gives the slots in this order. The preview and the record gate MUST share this one pass, thus the two refuse the same references.

A failure MUST name the block and the slot, thus the agent repairs one reference of one block. The pass MUST keep the value of the binding under the block id. It MUST keep the value of each other slot under the block id and the slot.

The track and each tree MUST resolve as a binding does: the pin, the row bound, the column subset, and the column match apply. The column match of the track MUST read the track table, and the column match of a tree MUST read its tree table. Neither match reads the bound table. A statistic MUST resolve as a metric value does, and the same assert rules apply.

The value bridge MUST map the resolved values onto the render value of the chart. The render value holds the rows of the binding, the rows of the track, and the rows of the tree of each axis. It also holds each statistic with its label, in block order. A track that resolves to no table MUST give a bridge mismatch that names the `track` slot. A tree that resolves to no table MUST give a bridge mismatch that names the slot of its axis. A statistic that resolves to no scalar MUST give a bridge mismatch that names its slot.

#### Scenario: Each slot of a chart resolves
- **WHEN** the pass resolves a chart with a track and two statistics against the fixture resolver
- **THEN** the binding value sits under the block id, and the track and each statistic sit under their slots

#### Scenario: A failed statistic names its slot
- **WHEN** the locator of the first statistic addresses a row that its table does not hold
- **THEN** the pass fails with `locator-out-of-range`, and the failure names the block and `statistic:0`

#### Scenario: An absent track column refuses
- **WHEN** the `end` of a track names a column that the track table does not hold
- **THEN** the pass fails, and the failure names the block, the `track` slot, and the absent column

#### Scenario: The record gate refuses the same statistic
- **WHEN** the record gate validates a chart whose statistic pins a stale hash
- **THEN** the gate refuses with `hash-mismatch`, and the failure names the slot of the statistic

#### Scenario: The render value carries the track and the statistics
- **WHEN** the bridge maps a chart with a resolved track and two resolved statistics
- **THEN** the render value holds the rows of the track and the two values with their labels, in block order

#### Scenario: A statistic of the wrong type is a mismatch
- **WHEN** a statistic of a chart resolves to a table
- **THEN** the bridge refuses, and the mismatch names the block and the slot of the statistic

#### Scenario: Each tree resolves under the slot of its axis
- **WHEN** the pass resolves a heatmap with a tree on `x` and a tree on `y` against the fixture resolver
- **THEN** each tree table sits under `tree:x` or `tree:y`, and the binding value sits under the block id

#### Scenario: An absent tree column names its slot
- **WHEN** the `height` of the tree of `y` names a column that the tree table does not hold
- **THEN** the pass fails, and the failure names the block, the `tree:y` slot, and the absent column

#### Scenario: The record gate refuses a stale tree
- **WHEN** the record gate validates a chart whose tree of `x` pins a stale hash
- **THEN** the gate refuses with `hash-mismatch`, and the failure names the `tree:x` slot

#### Scenario: The render value carries the trees
- **WHEN** the bridge maps a chart with a resolved tree on each axis
- **THEN** the render value holds the rows of each tree under its axis
