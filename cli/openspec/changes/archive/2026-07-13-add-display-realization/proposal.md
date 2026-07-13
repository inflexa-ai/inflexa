# Proposal — display realization (CLI side)

Companion change: `harness/openspec/changes/add-display-realization` (the
contract side: the `data-report-preview` rename and `show_user`'s `dataPath`).
This CLI change consumes those contracts; its renderers are written against
the renamed part types.

## Why

Three of the five harness display-card kinds are invisible in the CLI today:
`data-presentation` (everything `show_user` emits — charts, markdown, code,
tables, SVG), `data-file-reference` (`show_file`'s artifact galleries), and
`data-report-preview` all collapse to a one-line `[part:…]` mention, live and
on reload. The CLI is the user-facing OSS product; agent-shown content being
unrenderable there makes the display tools pointless in the primary surface.
A terminal cannot paint pixels, so the realization must split by content
shape: render text-shaped content inline, and give pixel-shaped content a
first-class "open externally" affordance.

## What Changes

- **Inline rendering for text-shaped `show_user` kinds** — `markdown` renders
  through the existing `<markdown>` renderable; `code` as a fenced block and
  `table` as a markdown table through the same renderable.
- **An openable card block for pixel-shaped content** — `data-file-reference`
  entries, `data-report-preview` versions, and materialized `echart`/`svg`
  presentations render as a card showing title, per-entry glyph + name +
  caption, and the resolved path; missing files render degraded, never crash.
- **Open-time resolution** — cards store the semantic reference (paths,
  previewId, spec, pres-id), resolved to an openable location only when the
  user opens: workspace file paths today, a local webserver URL in a future
  front+back architecture, with no transcript or contract change.
- **Materialization cache** — `echart` specs materialize to a self-contained
  HTML file (CDN-loaded ECharts, offline notice) and `svg` markup to an
  `.svg` file, in a CLI-owned cache keyed by the deterministic `pres-` id
  (disposable; regenerable from the transcript). Artifact-sourced charts
  (`dataPath`) get the CSV parsed and injected as `dataset.source` at
  materialization time.
- **A shared external-opener helper** — platform-picked argv including WSL
  handling (`wslview`/`explorer.exe`), Result-wrapped ENOENT, degrading to a
  notice with the path. Lifts the duplicated openers in `modules/auth/login.ts`
  and `modules/analysis/open.ts`.
- **Open UX** — click a card to open it; `o` opens the most recent openable
  card; a "Browse artifacts…" command-palette entry opens a `SelectDialog`
  picker over the session's openables (newest first); command ids remappable
  via `config.keybinds`.
- **Reload parity** — `cortexToUiMessage` maps the same part types through the
  same shared readers as the live path (closing its `TODO(extend)`).
- **REPL printer parity** — `chat_printer.ts` prints text-shaped presentations
  as text and openables as an OSC 8 `file://` hyperlink plus the plain path.

## Capabilities

### New Capabilities

- `artifact-open`: opening display-card content externally — the shared OS
  opener helper, open-time resolution, the materialization cache, and the
  open UX (click, `o`, picker).

### Modified Capabilities

- `chat-view`: the store maps `data-presentation`, `data-file-reference`, and
  `data-report-preview`(+`-failed`) to first-class parts, live and on reload.
- `tui-stream-blocks`: two new canonical blocks — the inline presentation
  block and the openable card block — with design-gallery exhibits.
- `chat-command`: the REPL printer renders the new parts (text inline,
  openables as OSC 8 link + path).

## Impact

- `src/tui/hooks/conversation.ts` (live + reload part mapping), part types in
  the message store
- `src/tui/layout/` (new blocks), `src/tui/layout/design_gallery.tsx`
- `src/tui/commands.tsx` + keymap (open commands), `SelectDialog` reuse
- `src/modules/harness/chat_printer.ts`
- New shared opener helper (lifting `modules/auth/login.ts` /
  `modules/analysis/open.ts` duplication); WSL gap in `analysis/open.ts`
  fixed by the same helper
- Depends on the harness change's renamed part types and `dataPath` field
- No new package dependencies: ECharts loads from CDN in the materialized HTML
