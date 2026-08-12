# Tasks: add-report-design-system

## 1. The assets and the manifest

- [x] 1.1 Add the exact-pinned dependencies: `echarts`, `@fontsource-variable/space-grotesk`, and `@fontsource-variable/ibm-plex-mono`.
- [x] 1.2 Export the asset manifest from `src/report-render`. Each entry names the staged file and its package source.
- [x] 1.3 Replace `CDN_HEAD` with relative `assets/<name>` script references, and remove the font links.
- [x] 1.4 Stage each manifest entry into `assets/` in the write pipeline of `preview-report.ts`, beside the figures.

## 2. The design sheet

- [x] 2.1 Make `src/report-render/design.ts`. Port the tokens and the typography from `templates/report-html/theme.css`.
- [x] 2.2 Port the component rules, the textures, and the motion rules from `base.html.j2`. Delete the dead rules.
- [x] 2.3 Add the `@font-face` rules that point at the staged font files.
- [x] 2.4 Add the `.chart-container` height rule.
- [x] 2.5 Add the `@media print` block and the `prefers-reduced-motion` block.
- [x] 2.6 Move the ECharts theme into `design.ts`. Keep the readiness names in `page.ts`, thus `lib/page-capture.ts` does not change.

## 3. The views

- [x] 3.1 Replace the Tailwind utility classes with semantic `report-*` classes in every view.
- [x] 3.2 Build the page architecture in `page-view.tsx`: the hero, the bands, the wide container, the reference band, and the footer.
- [x] 3.3 Render a consecutive run of metric siblings as one responsive grid, and a lone metric as one stat card.
- [x] 3.4 Render a table as the data-table form inside a corner-accent card.
- [x] 3.5 Render a chart as the window-chrome panel with the dots, the centered title, and the `CORTEX` badge.
- [x] 3.6 Render the figure card, the citation card, the styled claim markers, and the capped prose measure.
- [x] 3.7 Add the fade-in observer script as a page constant.

## 4. The gates and the fixture

- [x] 4.1 Extend the fixture document to every block kind, with a consecutive metric run.
- [x] 4.2 Extend `validity.test.ts`. The HTML gate, the CSS gate, and the determinism gate pass on the new page.
- [x] 4.3 Assert that the page holds no remote reference, and that each `assets/` reference names one manifest entry.
- [x] 4.4 Assert the asset stage step in the preview write pipeline.
- [x] 4.5 Add the fixture render script to `package.json`. It writes the fixture page with its assets, and it prints the path.
- [x] 4.6 Render the fixture, open the page, and do a visual check against `design-system.md`.
- [x] 4.7 Run `tsc -p tsconfig.json`, `bun test`, and `bun run format:file` on the changed files.
