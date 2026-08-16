# Tasks: render-the-tables-with-the-grid

## 1. The bundle

- [x] 1.1 `ag-grid-community` joins the harness dependencies, pinned exact, and its bundle joins the asset manifest.

## 2. The payload display member

- [x] 2.1 The table payload gains `display`: the header labels, the number kinds, and the below-resolution bounds, resolved server-side.
- [x] 2.2 A shared test vector pins the client formatter against the server helper.

## 3. The page

- [x] 3.1 The table card renders a grid mount, and the boot script builds one grid for each registered block.
- [x] 3.2 The grid theme builds from the design-token values, interpolated at build.
- [x] 3.3 The full raw value rides the cell tooltip, and the percent-delimited trim keeps its behavior on the grid.
- [x] 3.4 A missing payload keeps the header card and the download link, and the boot skips it.

## 4. The retirement

- [x] 4.1 The enhancer script, its marker, the filter input, the cap constant, and their styles go.

## 5. The proof

- [x] 5.1 Tests cover the four delta scenarios, and the retired surfaces appear nowhere on the page.
- [x] 5.2 Run the targeted suites of the touched modules, and `tsc -p tsconfig.json`.
