## 1. Authoring rules

- [x] 1.1 Extend the "Colors" section of `cli/CLAUDE.md`: every `<text>` in `src/tui/` resolves an explicit foreground, either `fg={theme().<role>}` on the element or every information-bearing child wrapped in `<Fg>`/`<Reverse>`; state that opentui's text default is opaque white and that both shapes are valid because an `fg` on the `<text>` propagates into child spans that do not override it.
- [x] 1.2 Extend the "Text emphasis" section: `<Bold>`/`<Italic>`/`<Underline>`/`<Dim>` set an attribute only and never a color, so each must sit inside an `<Fg>` or an `fg`-bearing `<text>`; `<Fg>` and `<Reverse>` are the only two that may be the outermost colored element. Add the banned shape — a bare string literal as a child of an `fg`-less `<text>`, including one sitting beside correctly-wrapped `<Fg>` siblings.
- [x] 1.3 Record the contrast floors and the verification obligation: 4.5:1 for text, 3:1 for non-text/decorative (borders, meter cells, separator glyphs, `fgSubtle`), and every new or changed TUI surface verified against a light theme (`github-light`, `bg` `#ffffff`) rather than only the dark default — noting that white measures 12–18:1 on dark themes, which is why the defect is invisible in normal use.
- [x] 1.4 State in the testing guidance that a `captureCharFrame()` / `toContain(...)` assertion proves a glyph was emitted, not that it is legible, and that any visibility claim must be backed by a span-color assertion.

## 2. The guard (build before the fixes, so it fails red first)

- [x] 2.1 Add a contrast helper to the render-test support layer computing WCAG 2.1 relative-luminance ratio from two resolved colors, and a tier classifier that returns the 3:1 floor for a span whose trimmed text is composed solely of decorative characters derived from `GLYPHS` (box-drawing set, `bar`, `middot`) and the 4.5:1 floor otherwise.
- [x] 2.2 Generalize `src/tui/theme_contrast.render.test.tsx` into a block-set sweep: render each covered block on `github-light`, walk `captureSpans()`, resolve each span's background from its own `bg` when opaque and from the theme surface otherwise, and fail any span under its tier floor with the block name, span text, ratio, and resolved colors in the message. Keep the two existing markdown-table and `ToolBlock` cases.
- [x] 2.3 Drive the covered block list from the design gallery's block set, reusing `design_gallery_fixtures.ts` where a block has fixtures.
- [x] 2.4 Confirm the guard fails on exactly the three regressed block titles and passes `ToolBlock`'s frame glyphs and `RunBlock`'s meter cells at their 3:1 floor. Record the observed failures before moving on.

## 3. Visibility fixes

- [x] 3.1 `src/tui/components/ask_prompt.tsx` — wrap the title in `<Fg role="fg">`.
- [x] 3.2 `src/tui/components/openable_card_block.tsx` — wrap the title in `<Fg role="fg">`.
- [x] 3.3 `src/tui/components/presentation_block.tsx` — wrap the title in `<Fg role="fg">`.
- [x] 3.4 `src/tui/layout/design_gallery.tsx` "Type & emphasis" panel — wrap the `bold`, `regular` (a bare literal), and `underline` specimens in `<Fg role="fg">`, and the `dim` and `italic` specimens in `<Fg role="fgMuted">`. Leave the `reverse` specimen unchanged: it resolves both foreground and background and is already correct.
- [x] 3.5 Fix the fixture blind spot in `src/tui/components/openable_card_block.render.test.tsx` — the card title and the row name are currently the same string, so the assertion passes on the row even when the title is unpainted. Give them distinct values.
- [x] 3.6 Re-run the guard and confirm every site now resolves a theme foreground.

## 4. Approval prompt — gutter-aligned marker

- [x] 4.1 Restructure `AskPrompt`'s choice mode into a row of (fixed gutter, content column): outer `<box flexDirection="row">` keeping `backgroundColor={theme().bgRaised}` and `flexShrink={0}`, a `<box width={size.gutter} flexShrink={0}>` holding the marker, and a `<box flexDirection="column" flexGrow={1}>` holding title, command, optional detail, and the hint row.
- [x] 4.2 Keep `boxRef` and `r.focusable = true` on the outermost box and the feedback-mode `TextInput` mounted as its descendant, so the target-gated key layer still authorizes the bare `y`/`a`/`n` bindings and stays live in feedback mode.
- [x] 4.3 Apply the same gutter alignment to feedback mode so the two modes do not shift horizontally when toggling.
- [x] 4.4 Change the transcript ask card's `pending` marker in `src/tui/layout/message_block.tsx` from `GLYPHS.circleHalf` to `GLYPHS.warning`, keeping the `warning` role and leaving the terminal statuses (`check`/`cross`/`circleHollow`) untouched.
- [x] 4.5 Extend `src/tui/components/ask_prompt.render.test.tsx` to pin the gutter alignment across the existing width sweep — the marker on the title row, and the command, detail, and hint rows at the gutter indent.

## 5. Openable card — marker column redesign

- [x] 5.1 Add `arrowUpRight: "↗"` (U+2197) to `GLYPHS` in `src/lib/design_system.ts` with a doc comment naming its role as the open-externally affordance and recording that it is single-cell and text-presentation by default.
- [x] 5.2 In `src/tui/components/openable_card_block.tsx`: delete `iconGlyph`, render every non-degraded row's marker as `arrowUpRight` in `accent`, keep `✗` in `error` for degraded rows, switch the folder-reveal row's marker from `triangleRight` to `arrowUpRight`, and drop the leading `circle` from the title row.
- [x] 5.3 Remove the `icon` field from `OpenableRowView` and from the row mapping in `src/tui/layout/message_block.tsx`.
- [x] 5.4 Delete `OpenableIcon` and `OpenableEntry.icon` from `src/types/session.ts`.
- [x] 5.5 Delete `iconForPath` and the four hardcoded `icon` call sites from `src/modules/harness/artifact_open.ts`, along with `IMAGE_EXTENSIONS` if it has no other reader.
- [x] 5.6 Update the openable-card exhibits in `src/tui/layout/design_gallery.tsx`: drop the `icon` fields, and give the single-entry chart card a title distinct from its row name so the exhibit stops rendering the same string twice.
- [x] 5.7 Verify a previously-persisted part carrying a stale `icon` key still deserializes — the read path is an unchecked `JSON.parse(...) as Part` cast, so confirm no reader was added that would reject the extra key.

## 6. Docs and verification

- [x] 6.1 Update `docs/color_contrast_audit.md` to record that the defect class extends beyond embedded renderables and syntax scopes to a block's own `<text>`, and that the rendered-span guard is the layer that catches it.
- [x] 6.2 Run `bun run format:file` on every changed file under `src/`.
- [x] 6.3 Run `bun run typecheck` and `bun run lint` clean — the type deletions in task 5 must surface every stale `icon` reader at compile time.
- [x] 6.4 Run the full `bun test` suite from inside `cli/` (never the monorepo root, whose missing preload bypasses the test sandbox).
- [x] 6.5 Open the design gallery and confirm on a light theme that the type-scale specimens, the three block titles, the gutter-aligned prompt, and the redesigned card rows all render correctly.
- [x] 6.6 Extend the rendered-span guard to `DiffBlock`, which the design gallery exhibits and which the guard's initial block set deliberately omitted while the red baseline was being established. Investigate any violation it surfaces rather than relaxing the floor to silence it.
