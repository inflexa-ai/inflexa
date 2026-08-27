# Report Render — delta

## ADDED Requirements

### Requirement: Each grounded block carries its lineage keys in the DOM
Each grounded block MUST carry its block id and the pin of each artifact reference as data attributes on its rendered container. The pin is the `path` and the `hash` of the reference. The grounded kinds are claim, metric, table, chart, figure, and citation. A citation block carries its external record identity in place of a pin.

#### Scenario: A grounded block renders its keys
- **WHEN** the render emits a claim with one artifact reference
- **THEN** the container carries the block id, the path, and the hash as data attributes

#### Scenario: A citation block renders its identity
- **WHEN** the render emits a citation block
- **THEN** the container carries the block id and the external record identity

### Requirement: The lineage library is a page asset
The lineage view library MUST ride in the asset manifest, and the page loads it from the local `deps/` directory. The harness imports no API from the library. When the page has no document asset, the page emits no lineage script and no popover control.

#### Scenario: The library ships with the page
- **WHEN** the preview renders with a document asset
- **THEN** the library lands in `deps/`, and the page references it with a relative source

#### Scenario: No document, no popover
- **WHEN** the render runs with no document asset
- **THEN** the page holds no lineage script and no popover control

### Requirement: The lineage popover
The page MUST open one popover that shows the backward chain of a grounded block, from a clickable control beside the reference marker. At most one popover is open at one time. The chain comes from the loaded document only, with no network request. A truncated chain and a pin with no node each show an explicit mark. The popover is hidden in print, and it obeys reduced motion. The markup passes the same validity gate as the page.

#### Scenario: A control opens the chain
- **WHEN** a reader clicks the lineage control of a grounded block
- **THEN** the popover opens beside the block, and it shows each hop back to the raw data

#### Scenario: One popover at a time
- **WHEN** a reader clicks a second lineage control while a popover is open
- **THEN** the first popover closes, and the second popover opens

#### Scenario: A pin with no node
- **WHEN** the document has no node for the pin of a block
- **THEN** the popover shows the pin as the last hop, with an explicit absence mark

#### Scenario: Print hides the popover
- **WHEN** the page prints
- **THEN** no popover and no lineage control appear in the printed output
