## 1. The markup

- [x] 1.1 Emit the raw cell value as a data attribute on each table cell in `src/report-render/views/values.tsx`.
- [x] 1.2 Add the cap markup: the hidden class on each row past the renderer cap, and the toggle with the total count.
- [x] 1.3 Add the filter input and the sortable header markup.
- [x] 1.4 Add the name trim: a percent-delimited value shows its first segment, with the full text on the `title` attribute.

## 2. The script and the styles

- [x] 2.1 Make the enhancer script in `src/report-render/page.ts` beside the spy: the sort cycle, the filter, and the cap that composes with both.
- [x] 2.2 Wire the script into the page assembly, after the spy.
- [x] 2.3 Add the design rules: the control styles, the hidden-row rule, the sort indicators, and the print reveal.

## 3. The gates

- [x] 3.1 Update and run the targeted render and view tests only.
- [x] 3.2 Run `bun run format:file` on the touched `src/` files, then `tsc -p tsconfig.json`.
- [x] 3.3 Render the fixture to the scratchpad, and confirm the enhancer markup, the script, and the trim by inspection.
