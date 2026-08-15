## 1. The number helper

- [x] 1.1 Make the pure helper in `src/report-render/` beside the design source. It takes a cell and a kind, and it gives `{ text, full? }`. `full` is present only when `text` hides digits. No locale API.
- [x] 1.2 Make the kind selection: a whole-token p-value column name selects `scientific` for a value in `(0, 1)`, an integer selects `compact`, and every other finite number selects `compact-scientific`. A non-numeric cell passes through.
- [x] 1.3 Unit tests for the helper: the scientific form, the grouping, the significant digits, the `full` presence rule, and the pass-through.

## 2. The call sites

- [x] 2.1 Apply the helper to the metric value in `src/report-render/views/values.tsx`, with the `title` attribute from `full`.
- [x] 2.2 Apply the helper to each numeric table cell in the table view, with the `title` attribute from `full`.
- [x] 2.3 Bound the chart axis tick precision in `src/report-render/chart.ts` where the inline JSON option admits text. Keep the derivation deterministic.
- [x] 2.4 Add the metric-card overflow guard to `DESIGN_CSS` in `src/report-render/design.ts`.

## 3. The gates

- [x] 3.1 Extend the render tests for the new forms: the metric card, the table cell, and the axis. Run the targeted `report-render` test files only.
- [x] 3.2 Run `bun run format:file` on the touched `src/` files, then `tsc -p tsconfig.json`.
