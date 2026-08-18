# Delta: report-verification

## MODIFIED Requirements

### Requirement: The eyes tool

The capture MUST measure the document height after the settle. A page at the single-shot bound or under MUST capture as one full-page shot. A taller page MUST capture as consecutive vertical slices in document order, each about two reader-window heights, because the provider path rejects a picture past its dimension cap and downscales a tall legal picture past legibility. A slice budget MUST bound the count, and a page taller than the budget covers MUST truncate honestly: the coverage carries the captured pixels against the total, and nothing pretends the look was whole.

The result MUST name the coverage of the pictures as a discriminant: the whole page in one shot, the tiled slices with the captured and the total pixels, or the viewport alone. Each slice MUST carry its document range, and the look result MUST mirror those ranges in picture order, thus the agent reads which rows each picture holds. The slices MUST ride the image path of the tool result in document order.

The capture MUST retry one time at the reader viewport when a screenshot throws, for the full-page shot and for a slice alike. A partial look — the viewport alone, or slices that the budget truncated — MUST still stamp the seen hash, because the agent saw the current document. Thus an oversized page degrades a look, and it never blocks the record path.

#### Scenario: A tall page arrives as slices

- **WHEN** the document height passes the single-shot bound
- **THEN** the result carries consecutive slices in document order, each with its document range, and the coverage carries the captured and the total pixels

#### Scenario: A short page keeps the one shot

- **WHEN** the document height sits at the single-shot bound or under
- **THEN** the result carries one full-page picture, and the coverage names the whole page

#### Scenario: A page past the budget truncates honestly

- **WHEN** the document height passes what the slice budget covers
- **THEN** the slices stop at the budget, and the coverage reports fewer captured pixels than total pixels

#### Scenario: A failed slice capture degrades to the viewport

- **WHEN** a slice screenshot throws and the viewport screenshot passes
- **THEN** the result carries the viewport picture, the coverage names the viewport, and the seen stamp lands

#### Scenario: A truncated look still stamps

- **WHEN** a tiled look reports fewer captured pixels than total pixels
- **THEN** the seen stamp lands, and the coverage is what tells the agent what it saw
