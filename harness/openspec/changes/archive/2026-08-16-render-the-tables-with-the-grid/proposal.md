# Proposal: render-the-tables-with-the-grid

## Why

The round-one enhancer re-implements sort, filter, and a row cap by hand. The data assets of the previous change emptied the DOM it works on. The decided direction of the tracker: the tables render through AG Grid Community, vanilla `createGrid`, pinned as a page asset beside ECharts. A working demo beside the session page proves the fit on `file://`.

## What Changes

- The harness gains one dependency, `ag-grid-community`, pinned. Its bundle joins the asset manifest exactly as the ECharts bundle does, and the page references it as a classic script.
- The table card renders a grid mount, and the page script boots one grid for each table block from the registered data. The client-side row model virtualizes the DOM.
- The payload gains a display member: the resolved header labels, the resolved number kind of each column, and the below-resolution bounds. The server resolves, and the page formats. Thus the format rules stay in one place, and the client half is a thin twin over the shipped kinds.
- The grid theme maps the design tokens: the palette, the typography, and the header treatment. The token values interpolate from the design source at build, thus one source styles the page and the grid.
- No separate filter row ships. The per-column filters and the header sort are the one filter surface.
- The vanilla enhancer retires: the script, the marker, the filter input, and the cap styles go. The print form shows the grid viewport, and the row bound of the binding is the size control.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-render`: the enhancer requirement goes, and the grid requirement takes its place.

## Impact

- Affected code: `harness/package.json`, `src/report-render/assets.ts`, `src/report-render/table-data.ts` (the display member), the table view, `src/report-render/page.ts` (the boot script), `src/report-render/design.ts` (the theme), and their tests.
- The eyes checklist and the capture stay unchanged, and the page still stands alone.
