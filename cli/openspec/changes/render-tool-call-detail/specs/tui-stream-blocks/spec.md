## MODIFIED Requirements

### Requirement: Eight canonical stream-block states

The chat stream SHALL render the eight canonical block states of the design system, each as a gutter-marked block sharing the fixed 2-cell gutter (`size.gutter`) so only the marker glyph and its role color change between blocks:

1. **welcome / startup** — shown at the top of an empty stream; a wordmark plus the active context (greeting, anchor path with ✓/⚠ badge, resume hint, command hint).
2. **plain chat turn** — the existing user/assistant `MessageBlock` (markdown body under a `>`/`<` marker).
3. **thinking / reasoning** — a `◆ thinking` marker, an optional duration, and a collapsed-by-default italic reasoning body that can expand.
4. **tool call & result** — a `▸` marker with the tool/verb name and the call's detail, and the call's status (ok / running / error / denied, with duration); the detail sits on the name line when it fits and reflows to one indented row beneath when it does not (see "A tool block reflows a detail that does not fit"); for a call without a rendered result the status sits on the name line (see "Tool status placement is prop-controlled"), and for a call with a result the result renders in a `<code>` block with the status as a completion line beneath it.
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

### Requirement: Tool status placement is prop-controlled

`ToolBlock` SHALL take an `inlineStatus?: boolean` prop controlling where the call's status (glyph + label + optional duration) renders: on the name line — after the name and, when it fits there, the detail, separated by a `space.md` gap — or as a standalone completion line below the block's content. The default SHALL derive from the result: a block without a `result` renders on the name line (live harness tool events never carry a result, so every live call uses that form), and a block with a `result` keeps the completion line below the `<code>` panel, where an inline status would strand the outcome above the output it describes. An explicit prop value SHALL override the derivation (the design gallery pins both forms).

When the detail reflows to a continuation row, the status SHALL remain on the name line rather than following the detail down. The name line then carries only the marker, the tool name, and the status, which places the status in a near-constant column across split blocks.

The inline form SHALL NOT right-align the status (a wrapped right-aligned segment lands at column 0 and breaks the gutter); it flows after the name so narrow terminals soft-wrap it instead. This holds for the split form too — removing the detail from the name line shortens that line but does not make right-alignment safe. Both placements SHALL be pinned by frame-assertion render tests, including a sidebar-open-width (40-column) sweep.

#### Scenario: Live tool call renders on one line

- **WHEN** a tool call without a result renders (running or finished) and its detail fits the available width
- **THEN** the name, detail, and status share one line — `▸ name detail  ✓ ok · 14ms` — with a `space.md` gap before the status

#### Scenario: A result keeps the completion line

- **WHEN** a tool block renders with a `result`
- **THEN** the result renders in the `<code>` panel and the status renders as a completion line beneath it, as before

#### Scenario: The status stays on the name line when the detail reflows

- **WHEN** a tool call's detail does not fit and drops to a continuation row
- **THEN** the status renders on the name line beside the tool name, not on the continuation row

#### Scenario: The gallery pins both placements

- **WHEN** the design gallery renders the tool-block exhibits
- **THEN** it shows the inline form and the completion-line form via explicit `inlineStatus` values

## ADDED Requirements

### Requirement: A tool block reflows a detail that does not fit

`ToolBlock` SHALL take an optional `detail` string describing what the call is doing, and SHALL render it in a muted role. The detail SHALL render on the name line when it fits the available width, and SHALL otherwise render on one row indented by `space.md`. The detail SHALL NOT be truncated in either form.

The block SHALL derive the available width from `useTerminalDimensions()`, subtracting the sidebar rail, the gutter, and the block's own spacing. The subtraction SHALL assume the sidebar is present. An over-subtraction costs one unnecessary row; an under-subtraction produces a soft wrap at column 0, which breaks the fixed gutter — so the measurement SHALL be biased toward splitting early.

The detail is one opaque display string owned by the harness. The block SHALL NOT split it, key on its contents, or derive fields from it.

#### Scenario: A short detail stays on the name line

- **GIVEN** a tool block whose detail fits the available width
- **WHEN** it renders
- **THEN** the detail follows the tool name on the same line

#### Scenario: A long detail reflows whole

- **GIVEN** a tool block whose detail is a workspace path longer than the available width allows
- **WHEN** it renders
- **THEN** the detail appears in full on an indented continuation row, with no ellipsis and no truncation

#### Scenario: The split point is width-dependent and swept by tests

- **GIVEN** one tool block fixture whose detail crosses the fitting boundary
- **WHEN** the render tests sweep terminal widths including the 40-column sidebar-open case
- **THEN** the fitted form and the split form are each asserted at a width that produces them

#### Scenario: A block with no detail is unchanged

- **GIVEN** a tool block with no `detail`
- **WHEN** it renders
- **THEN** it produces one line, exactly as it does without the field

### Requirement: A denied call renders as a soft state, not a fault

The tool-call status set SHALL be `running | ok | error | denied`. `denied` SHALL render `GLYPHS.warning` in the `warning` role with the label `denied`.

A denial is the user's own decision to refuse an approval, not a failure of the tool. Rendering it with the error glyph tells the user their choice went wrong. `GLYPHS.warning` is defined as a soft state weaker than `GLYPHS.cross`, which is what a refusal is; no new glyph is introduced.

#### Scenario: A refused approval reads as denied

- **GIVEN** a tool call whose approval request was rejected
- **WHEN** its block renders
- **THEN** it shows the warning glyph in the warning role with the label `denied`, not the error glyph

#### Scenario: The denied state has distinct span color

- **WHEN** the render tests capture spans for the denied status
- **THEN** the status span resolves the `warning` role, distinct from both `success` and `error`, on a light theme as well as a dark one

#### Scenario: The gallery pins the denied state

- **WHEN** the design gallery renders the tool-block exhibits
- **THEN** it shows a denied call beside the ok, running, and error states
