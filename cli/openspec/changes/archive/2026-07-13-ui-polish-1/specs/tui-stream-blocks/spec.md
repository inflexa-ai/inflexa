## MODIFIED Requirements

### Requirement: Eight canonical stream-block states

The chat stream SHALL render the eight canonical block states of the design system, each as a gutter-marked block sharing the fixed 2-cell gutter (`size.gutter`) so only the marker glyph and its role color change between blocks:

1. **welcome / startup** — shown at the top of an empty stream; a wordmark plus the active context (greeting, anchor path with ✓/⚠ badge, resume hint, command hint).
2. **plain chat turn** — the existing user/assistant `MessageBlock` (markdown body under a `>`/`<` marker).
3. **thinking / reasoning** — a `◆ thinking` marker, an optional duration, and a collapsed-by-default italic reasoning body that can expand.
4. **tool call & result** — a `▸` marker with the tool/verb name and target, and the call's status (ok / running / error, with duration); for a call without a rendered result the status sits inline on the name line (see "Tool status placement"), and for a call with a result the result renders in a `<code>` block with the status as a completion line beneath it.
5. **long-running run / task** — a `●` marker with the run name, a progress bar, and an indented step list (done / running / queued).
6. **diff / file edit** — a `✎` marker with the file name and +/− counts, the hunk rendered via the `<diff>` renderable, and accept/reject/edit affordances.
7. **error / abort** — a `✗` marker, the abort/error summary, and a bordered callout (using `stroke.danger` chrome and `onAccent` foreground on any filled region); the degraded-anchor case (`markerWritten = false`) renders its callout from existing anchor state.
8. **command palette** — the existing `^K` palette overlay.

Each block SHALL map to a single built-in opentui renderable (no custom drawing), read all colors via `theme().<role>`, all non-ASCII glyphs via `GLYPHS`, and all spacing/dimension/stroke via the design tokens. Markers SHALL come from the shared marker set (`MARKERS`) in `src/lib/design_system.ts`.

#### Scenario: Blocks share the fixed gutter

- **WHEN** any two block types render consecutively in the stream
- **THEN** their content aligns in the same gutter column (`size.gutter`) and only the marker glyph and its color differ

#### Scenario: Each block uses a built-in renderable

- **WHEN** a block renders code, a diff, a wordmark, or text
- **THEN** it uses `<code>`, `<diff>`, `<ascii_font>`, or `<text>`/`<box>` respectively — no custom cell drawing

#### Scenario: No inlined hex or glyph literals

- **WHEN** a block paints a color or prints a non-ASCII glyph
- **THEN** the color comes from `theme()` and the glyph from `GLYPHS`, never an inline literal

## ADDED Requirements

### Requirement: Tool status placement is prop-controlled

`ToolBlock` SHALL take an `inlineStatus?: boolean` prop controlling where the call's status (glyph + label + optional duration) renders: inline on the name line — after the name and target, separated by a `space.md` gap — or as a standalone completion line below the block's content. The default SHALL derive from the result: a block without a `result` renders inline (live harness tool events never carry a result, so every live call uses the single-line form), and a block with a `result` keeps the completion line below the `<code>` panel, where an inline status would strand the outcome above the output it describes. An explicit prop value SHALL override the derivation (the design gallery pins both forms). The inline form SHALL NOT right-align the status (a wrapped right-aligned segment lands at column 0 and breaks the gutter); it flows after the name so narrow terminals soft-wrap it instead. Both placements SHALL be pinned by frame-assertion render tests, including a sidebar-open-width (40-column) sweep.

#### Scenario: Live tool call renders on one line

- **WHEN** a tool call without a result renders (running or finished)
- **THEN** the name, target, and status share one line — `▸ name target  ✓ ok · 14ms` — with a `space.md` gap before the status

#### Scenario: A result keeps the completion line

- **WHEN** a tool block renders with a `result`
- **THEN** the result renders in the `<code>` panel and the status renders as a completion line beneath it, as before

#### Scenario: The gallery pins both placements

- **WHEN** the design gallery renders the tool-block exhibits
- **THEN** it shows the inline form and the completion-line form via explicit `inlineStatus` values
