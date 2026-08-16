# Design: render-the-tables-with-the-grid

## Context

The data assets register each table's rows on the page, decoded, under the block id. The table card shows the header and the download link, and the round-one enhancer is inert over the empty body. The asset manifest (`src/report-render/assets.ts`) stages the ECharts bundle from its package. The page references it as a classic script, the one mechanism that a `file://` page admits.

## Decisions

### D1: The bundle ships exactly as ECharts does

`ag-grid-community` joins `dependencies`, pinned exact. The manifest gains one entry over `ag-grid-community/dist/ag-grid-community.min.js`, and the preview stages it beside the page. The vanilla `createGrid` global serves, and no framework wrapper joins — the locked decision of the tracker.

### D2: The server resolves, and the page formats

The payload gains a `display` member: the resolved header label of each column, the resolved number kind, and the below-resolution bound where one exists. The kind resolution — the declaration, the token guess, the magnitude arms, the zero rule — stays server-side, where it is tested. The page script holds one small formatter over the shipped kinds. A shared test vector pins the client twin against the server helper, thus the two cannot drift in silence.

### D3: The theme interpolates the design tokens at build

The grid theme builds with `themeQuartz.withParams`, and the parameter values interpolate from the design-source token constants into the page script. One source styles the page and the grid, and no CSS custom property crosses into the grid parameters, because the theming API takes values.

### D4: The grid boots after the payloads, from the registry

The boot script walks the grid mounts and reads the decoded rows of each block id. It builds the column definitions from the display member, and it calls `createGrid`. The page script is design-source code, thus a real function formatter is admitted there. The inline-JSON constraint binds the chart option, and never the page script.

### D5: The filter surface is the grid's own

The per-column filters and the header sort ship enabled, and no quick-filter input renders. A second input would rebuild what the grid gives, and the review of the mechanism demo already rejected one.

### D6: The enhancer retires whole

The enhancer script, its marker, the filter input, the cap constant, the hidden-row classes, and their styles go. The grid owns the table presentation, thus the page keeps one table mechanism. The print form takes the grid's print layout, thus every bounded row prints. The row bound of the binding keeps the print sane, and that pairing is the decided size control.

### D7: A missing payload leaves the card honest

A grid mount whose block id the registry does not hold renders the header-only card with the download link, and the boot skips it. Absence is a normal condition, and the page never throws over it.

## Risks / Trade-offs

- The bundle is about two times the ECharts weight. The cost is one static asset beside the page, and the decided direction accepts it.
- The grid markup is div-based, not a semantic table. The trade came with the decision, and the data rides the download for any reader that wants the raw form.
