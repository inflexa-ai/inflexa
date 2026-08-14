# Design: add-report-design-system

## Context

The new renderer builds one column at `max-w-4xl` with a left nav (`src/report-render/views/page-view.tsx:57`). Its style sheet is a partial copy of the old theme (`src/report-render/page.ts:25`). The head pulls Tailwind, ECharts, and the two fonts from jsDelivr (`src/report-render/page.ts:15-19`).

The copy has three defects:

- The views use `text-primary-500` (`views/prose.tsx:111`), but no `@theme` block registers the tokens. Thus the Tailwind runtime makes no color for them.
- No rule gives `.chart-container` a height (`views/chart-view.tsx:25`). A zero-height div shows no chart.
- The sheet holds rules that no view emits, for example `.terminal-card` and `.block-progress`.

The old identity lives in `templates/report-html/theme.css`, in `templates/report-html/base.html.j2`, and in `skills/report-html/references/design-system.md`. Outside the renderer, only `src/lib/page-capture.ts` imports the page constants. It takes the readiness sentinel names.

The figure pipeline already stages bytes beside the page. `figureSourcePolicy` returns `assets/<name>` (`src/tools/report-session/preview-report.ts:98-100`), and the write step copies each figure into `assets/`.

## Goals / Non-Goals

**Goals:**

- Render a block document with the full Inflexa identity: the tokens, the components, and the page architecture.
- Make the rendered page self-contained, with no CDN reference at view time.
- Repair the three copy defects.
- Define the evolution path of the design, and the rule for a new block kind.

**Non-Goals:**

- No change to the block grammar (`src/contracts/report-blocks.ts`), and no new block kind.
- No change to the old path: `templates/report-html`, `previews/`, and the Nunjucks renderer.
- No change to the verification semantics of `examine_page` and `record_version`.
- No dark theme, and no PDF export. The print form is a `@media print` sheet.

## Decisions

### D1. The identity port covers both levels

The port takes the tokens and the components, and it also takes the page architecture. The architecture is the hero, the full-bleed alternate sections, the textures, the wide container, and the dark footer. The three identity sources above are the reference. The alternative was a port of the tokens alone. It was rejected, because the architecture carries the visible quality that #221 asks for.

### D2. The page becomes self-contained through the sibling `assets/` directory

The renderer emits `assets/<name>` references for the ECharts runtime and the fonts. It exports one asset manifest: each entry names the file and its package source. The caller stages the bytes into `assets/`, in the same write pipeline that stages the figures.

The bytes come from three exact-pinned dependencies: `echarts`, `@fontsource-variable/space-grotesk`, and `@fontsource/ibm-plex-mono`. The renderer stays a pure function, and it reads no file.

Two alternatives were rejected:

- The CDN head stays. Rejected: print and offline view fail without a network, and a frozen version decays when the CDN drops the pin.
- One inline HTML file. Rejected: the source would hold megabyte string constants, a base64 font grows by a third, and the figure pipeline already proves the sibling-directory form.

### D3. Static CSS replaces the Tailwind runtime

The views drop the utility classes and use semantic `report-*` classes. One design sheet holds the tokens, the typography, the components, the textures, the motion rules, and the print rules. The sheet ports from `theme.css` and from the style block of `base.html.j2`. Own `@font-face` rules point at the staged font files.

The sheet and the ECharts theme move to `src/report-render/design.ts`. `page.ts` keeps the bootstrap and the readiness names, thus `src/lib/page-capture.ts` does not change. The alternative was a build-time Tailwind compile. It was rejected: it adds build tools to a published library, and a utility chain resists a human edit.

### D4. The page architecture maps onto the document

- The hero shows a constant eyebrow and the document title, with no date and no lede, because the render uses no clock.
- Each top-level section renders as a full-bleed band. The backgrounds alternate white and slate-50, and the textures alternate dots and grid, with noise on top.
- The inner container is wide (`max-w-[1600px]`), and the left nav keeps its layout shift.
- The reference list renders as the final band. The dark footer closes the page.

### D5. Each block kind gets a considered form

- `text`: prose with a capped measure of about 72 characters, for a readable line inside the wide band.
- `claim`: prose with the styled evidence markers. The marker semantics do not change.
- `metric`: a stat card with the mono value and an accent. A consecutive run of metric siblings renders as one responsive grid.
- `table`: the data-table form in a corner-accent card. The header is mono and uppercase.
- `chart`: the window-chrome panel with the dots, the centered title, the `CORTEX` badge, and a fixed 400px body.
- `figure`: a corner-accent card with the caption.
- `citation`: a card in the reference form, with the note.
- `section`: a heading by depth inside its band.

### D6. Motion and print port from the old base

The fade-in observer script becomes a page constant. `prefers-reduced-motion` collapses each duration. The print sheet hides the textures, shows each fade-in element, and turns the footer light.

### D7. The rule for a new block kind

The block grammar names content and its grounding, never presentation. A presentation improvement changes the renderer, not the grammar. A new kind is correct only when the agent must supply content that no current kind carries, with its own binding shape. No style field enters the grammar. The `report-design-system` spec records this rule.

### D8. The evolution path of the design

A person edits `design.ts` and the views. The gates protect the edit: the HTML validity gate, the CSS validity gate, and the determinism gate. One fixture document covers every block kind. A package script renders the fixture to a file and prints the path, thus a person looks at the page directly.

### D9. The page-asset lookup is a seam of the preview tool

`preview_report` takes an optional `resolvePageAsset` dep. The dep maps the module specifier of a manifest entry onto an absolute file path. Absent, the tool keeps the current behavior: `createRequire(import.meta.url).resolve(...)` against the installation of the harness.

The default serves an npm consumer and a Node.js consumer, because both have a `node_modules` tree beside the harness. A compiled single-file binary has none. There `import.meta.url` names a virtual root, the resolution walks the working directory upward, and each specifier fails. The whole preview then fails with `write-failed`, and the fault has nothing to do with the workspace.

Thus an embedder that packs the asset bytes into its binary materializes them to disk at boot, and it binds its own lookup. The dep crosses `PreviewReportToolDeps`, `ReportSessionAgentDeps`, and `CoreRuntimeDeps` (as `resolveReportPageAsset`). Each bag holds it as optional, thus no current caller changes.

`report-render/assets.ts` stays pure data. The manifest names the specifier alone, and the caller owns the lookup. A lookup that throws keeps the `fs` failure kind, thus the outcome vocabulary of the tool does not grow.

### D10. The front door carries the manifest, and not a deep path alone

An embedder that binds its own lookup reads the manifest to know which files to stage. It already reads the type of that lookup from the front door. Thus the value that the type describes belongs beside it.

A deep subpath resolves today, and it stays importable. But the front door is the curated surface that an embedder faces, and half a contract on it is worse than none. A hand-kept copy of the entries in an embedder is the outcome that this export prevents.

## Risks / Trade-offs

- [A caller does not stage the assets, and the page opens without charts] → The manifest export makes the stage step explicit. A gate asserts the stage step, and `examine_page` reports each failed request.
- [The `echarts` package adds install weight to each embedder] → The pin is exact, and only the dist file copies into a page directory. The weight is an accepted trade-off.
- [The handwritten sheet drifts from the old templates while both live] → The old path does not change, and `design-system.md` stays the shared reference. #313 removes the old path later.
- [The wide band and the left nav overlap at middle widths] → The port keeps the `body:has(#report-sidebar)` shift, and the fixture look covers it.
- [A publish must carry the assets, not only the page] → The #333 rule makes a publish a copy of the rendered bytes. The figure assets set the precedent.

## Migration Plan

The change is additive. No caller reaches the new path until #314 lands, thus no user sees it. The spec delta lands with the change. A rollback is one revert of a dormant path.

## Open Questions

None.
