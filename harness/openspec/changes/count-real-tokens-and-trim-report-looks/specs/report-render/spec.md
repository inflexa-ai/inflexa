## ADDED Requirements

### Requirement: Each rendered block carries its block mark

The renderer MUST mark each block of the page with its id, in the attribute `data-block`. Each of the eight block kinds MUST carry the mark, the section included. The mark MUST sit on each element at the top of the markup of the block, and it MUST add no element.

A text block has no container, thus each of its paragraphs and its list carry the mark. A claim carries the mark on its paragraphs. When the page shows the lineage, a wrapper holds the paragraphs of a claim, and only the wrapper carries the mark.

The capture of one block reads the union of the marked boxes (see the report-verification capability). Thus the mark is the one contract between the render and the capture of a block.

#### Scenario: Each block carries its id

- **WHEN** the caller renders a document with one block of each kind, with the lineage and without it
- **THEN** the markup of each block carries `data-block` with the id of that block

#### Scenario: A text block marks each paragraph and its list

- **WHEN** the caller renders a text block with two paragraphs and a list
- **THEN** each paragraph and the list carry the mark, and the markup holds no added element
