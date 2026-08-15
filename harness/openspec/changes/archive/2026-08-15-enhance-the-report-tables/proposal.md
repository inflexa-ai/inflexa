## Why

A table block dumps every CSV row as plain HTML. On the first real report the GSEA table printed every row with raw set names that carry encoded noise. The table scrolled horizontally, and nothing sorts, nothing filters, and nothing bounds the visible rows.

## What Changes

- A vanilla enhancer joins the page script: click-to-sort on a header, one filter input for each table, and a row cap with a "show all N" toggle. No framework, no dependency, and no hydration.
- The rows stay in the DOM. The cap hides rows with a class, and the toggle reveals them, thus no data moves and the page stays a self-contained document.
- The renderer trims a display name with encoded noise, and the full text rides the `title` attribute.
- The default row cap lives in the renderer. No block gains a field, because the column subset already covers the content-level choice.

## The decided boundary

No React and no table framework on the page. The page is a self-contained deterministic document, and a runtime with hydration works against the verifier, the eyes, and the design system.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-render`: a new requirement gives the table enhancer: the sort, the filter, the row cap with the toggle, and the name trim.
- `report-design-system`: the table component names the enhancer controls.

## Impact

- `harness/src/report-render/page.ts` — the enhancer script.
- `harness/src/report-render/design.ts` — the control rules and the hidden-row rule.
- `harness/src/report-render/views/values.tsx` — the sort attributes, the trim, and the cap markup.
- No contract change, no tool change, and no store change.
