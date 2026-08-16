# Proposal: type-the-text-list

## Why

The Limitations section of the session page is one twelve-line paragraph with "(1) … (6)" inline. The renderer splits prose on blank lines alone, and it knows no list. Thus the agent had no better form to reach for, and an enumeration reads as a wall.

## What Changes

- The text block gains an optional typed list beside `prose`: an items array and an ordered flag. Each item is one line of inline text.
- The renderer emits the list markup after the prose paragraphs, and the runtime escape covers each item. No markdown engine joins.
- A text block can carry a list with an empty prose. An empty prose with no list stays as it parses today.
- The free-numeral advisory of the finish covers a list item exactly as it covers a paragraph.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-block-model`: the text block admits the typed list.
- `report-render`: the list renders as list markup in the content column.

## Impact

- Affected code: `src/contracts/report-blocks.ts`, `src/report-render/views/prose.tsx`, the free-numeral walk, and their tests.
- The field is optional, thus every stored document parses and renders as before.
- The prompt obligation — an enumeration composes as a list — rides the prompt child of the tracker.
