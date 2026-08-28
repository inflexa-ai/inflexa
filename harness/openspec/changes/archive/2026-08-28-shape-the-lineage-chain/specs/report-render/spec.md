# Report Render — delta

## MODIFIED Requirements

### Requirement: The lineage popover
The page MUST open one popover that shows the backward chain of a grounded block, from a clickable control beside the reference marker. The control is a stroke-drawn branch glyph, muted at rest and primary on hover, with an accessible label. At most one popover is open at one time. The chain comes from the loaded document only, with no network request.

The popover MUST render the chain from the edges of the walk, and it MUST NOT render the flat node set. The rail alternates the artifact, the command that made it, and the files that the command read. A producer row carries the script, the step, and the hash head. Each input file continues the rail with its own producer, and a raw input ends its branch with a distinct terminal form. A bookkeeping node MUST NOT render as a row. The other outputs of a command MUST collapse behind one count row.

A row carries a type tag, the path, and the hash head. The path MUST drop the shared run prefix, because every hop of one chain carries it, and the tail holds the meaning. The width of the popover obeys its longest row, up to a viewport cap. Thus a name renders whole in a normal window, and a cut is the exception. In a narrow window, a long tail truncates at its start, and an over-long name cuts in its middle. The extension stays visible in both forms, and the full path rides the hover. The body MUST scroll inside a capped height, and the popover MUST NOT overflow the page. The popover MUST NOT cover its own control: it opens below the control, and it flips above when the space below is short. A truncated chain and a pin with no node each show an explicit mark. The popover is hidden in print, and it obeys reduced motion. The markup passes the same validity gate as the page.

#### Scenario: A control opens the chain
- **WHEN** a reader clicks the lineage control of a grounded block
- **THEN** the popover opens beside the block, and it shows each hop back to the raw data

#### Scenario: One popover at a time
- **WHEN** a reader clicks a second lineage control while a popover is open
- **THEN** the first popover closes, and the second popover opens

#### Scenario: The rail excludes the off-chain files
- **WHEN** the producing command wrote twelve other files beside the pinned artifact
- **THEN** the rail shows the pinned artifact and one count row, and no off-chain file renders as a hop

#### Scenario: A deep chain scrolls inside the popover
- **WHEN** the chain is taller than the capped height
- **THEN** the body scrolls inside the popover, and the page does not grow

#### Scenario: The run prefix stays off the rows
- **WHEN** every hop of a chain sits under one run
- **THEN** the rows show the tails without the run prefix, and the hover shows the full path

#### Scenario: The popover clears its control
- **WHEN** a reader clicks a control low on the page
- **THEN** the popover opens above the control, and no part of it covers the control

#### Scenario: A normal window cuts nothing
- **WHEN** the window gives the popover its capped width
- **THEN** every row of the chain shows its whole name, with no ellipsis

#### Scenario: The extension survives a narrow window
- **WHEN** the window is too narrow for two sibling names that differ only in their extension
- **THEN** each row shows the start of the name and the extension, and the cut sits in the middle

#### Scenario: A pin with no node
- **WHEN** the document has no node for the pin of a block
- **THEN** the popover shows the pin as the last hop, with an explicit absence mark

#### Scenario: Print hides the popover
- **WHEN** the page prints
- **THEN** no popover and no lineage control appear in the printed output
