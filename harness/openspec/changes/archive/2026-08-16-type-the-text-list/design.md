# Design: type-the-text-list

## Context

`TextBlockSchema` carries `content: { prose }` (`src/contracts/report-blocks.ts:155-159`), and the prose admits an empty string today. The prose view splits on blank lines and emits paragraphs (`src/report-render/views/prose.tsx:25-34`). No block form renders a list, thus an enumeration lands inline in one paragraph.

## Decisions

### D1: The list is typed content, not markdown

`content.list` is an optional strict object: `ordered: boolean`, and `items: string[]`, each item non-empty, at least one item. A markdown engine would admit links, emphasis, and nesting, and each one is a review surface that the block model closed on purpose. One flat list of inline lines covers the enumeration case that the page shows.

### D2: The list renders after the prose

The lead sentences introduce the enumeration, and the items follow. The renderer emits `ol` or `ul` by the flag, one `li` for each item, escaped exactly as a paragraph. The list fills the content column, as every block does.

### D3: No new emptiness rule

An empty prose parses today, and the list changes nothing about that. A text block with a list and an empty prose renders the list alone. The gap check of the finish reads sections, and a text block with a list is content in the same way as one with prose.

### D4: The free-numeral advisory walks the items

The advisory reads the prose of a text block today. A numeral in a list item is the same honesty concern, thus the walk covers the items beside the prose.

## Risks / Trade-offs

- A very long item wraps as a paragraph would, and no sub-list exists. The flat form is the point, and a deeper structure is a section with blocks.
