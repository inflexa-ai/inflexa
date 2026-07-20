## Why

opentui's text renderable defaults its foreground to opaque white (`_defaultOptions = { fg: RGBA.fromValues(1,1,1,1) }`). Any `<text>` without an explicit `fg`, and any `<Bold>`/`<Italic>`/`<Underline>`/`<Dim>` not nested inside an `<Fg>` or an fg-bearing `<text>`, therefore renders pure white: 12–18:1 on the five dark themes (readable but off-palette) and **1.00–1.13:1 on the five light themes** — `github-light` measures exactly 1.00:1, fully invisible. Eight such sites currently ship, including all three block titles the user reported and, most embarrassingly, five of the six specimens in the design gallery's own "Type & emphasis" reference, where the captions render and the words they describe vanish.

This is a **regression of an already-diagnosed defect class**, not a new discovery. `docs/color_contrast_audit.md` documented this exact `#FFFFFF` fallthrough and its 1.00–1.13:1 light-theme figures; `theme-system` already forbids it for syntax scopes and `tui-stream-blocks` already forbids it for embedded renderables. It recurred because neither rule reaches a block's own `<text>`, and because no guard can catch it: the palette matrix validates declared tokens and is structurally blind to text carrying no token, while every `*.render.test.tsx` asserts through `captureCharFrame()`, which sees characters but never color. Fixing the eight sites without closing that gap guarantees a fourth recurrence.

## What Changes

- **Authoring rules that make the invariant explicit.** `cli/CLAUDE.md` gains rigorous, testable TUI rules extending its existing "Colors" and "Text emphasis" sections: every `<text>` carries an explicit foreground; the emphasis wrappers set no color and must sit inside one; a bare string literal in an fg-less `<text>` is the same bug; thresholds are 4.5:1 text / 3:1 non-text; every new or changed block is verified on a light theme, never only the dark default; and a `toContain()` frame assertion is stated to prove glyph presence, not visibility.
- **A guard that enforces them.** `src/tui/theme_contrast.render.test.tsx` grows from a hand-enumerated two-component test into a block-set sweep that renders on `github-light`, walks `captureSpans()`, and fails any span under its tier floor. The guard must honour the text-vs-decoration split — a uniform 4.5:1 pass wrongly flags `ToolBlock` borders (3.03:1) and `RunBlock` meter cells (3.36:1), which legitimately pass their 3:1 non-text floor.
- **Eight visibility fixes** across `ask_prompt.tsx`, `openable_card_block.tsx`, `presentation_block.tsx`, and the five gallery type-scale specimens, plus the test blind spot that hid one of them (`openable_card_block.render.test.tsx` asserts a string that is both the title and the row name).
- **The approval prompt moves to a gutter-aligned marker**, so `⚠` occupies the shared 2-cell gutter and the title, command, detail, and key hints hang at that indent — the glyph marks the block rather than decorating one row, and the prompt aligns with the transcript above it. The same ask currently shows `⚠` docked and `◐` as a transcript card; the change settles one vocabulary.
- **The openable card's marker column is redesigned** to answer one question — does this open, or is it broken? The decorative title `●` is dropped, the four content-kind glyphs (`◐ ◆ ▸ ✎`, every one of which collides with a status meaning elsewhere) collapse into a single `↗` open-external affordance, and `✗` keeps marking degraded rows. Content kind stays legible from the filename, which does that job better than a terminal glyph can. **BREAKING** (internal only): `OpenableIcon`, `OpenableEntry.icon`, `OpenableRowView.icon`, and `iconForPath` are deleted — `icon` is derived CLI-locally, never carried on a harness wire, so nothing outside `cli/` observes it.

## Capabilities

### New Capabilities

None. Every change extends an existing capability.

### Modified Capabilities

- `theme-system`: adds a requirement that every rendered text span resolves an explicit theme foreground — closing the gap between the palette matrix (which validates declared tokens) and what actually reaches the screen — plus the authoring rule that a block's own `<text>` is covered, not just embedded renderables and syntax scopes.
- `tui-text-emphasis`: states that `<Bold>`/`<Italic>`/`<Underline>`/`<Dim>` emit no color and are only legal inside an `<Fg>` or an fg-bearing `<text>`, and that the gallery's type-scale panel must render each specimen *visibly* in every built-in theme.
- `tui-stream-blocks`: extends the themed-color requirement from embedded renderables to the blocks' own `<text>` elements, and replaces the openable card's content-kind glyph row marker with the open-external affordance model.
- `tui-ask-approval`: specifies the docked prompt's gutter-aligned layout and one marker vocabulary shared by the docked prompt and the transcript ask card.
- `tui-test-coverage`: adds the rendered-span contrast guard as a required test, and records that character-frame assertions do not establish visibility.

## Impact

- **Components**: `src/tui/components/ask_prompt.tsx`, `openable_card_block.tsx`, `presentation_block.tsx`; `src/tui/layout/design_gallery.tsx` (type-scale specimens, openable-card exhibits), `src/tui/layout/message_block.tsx` (ask marker, openable row mapping).
- **Types / logic**: `src/types/session.ts` (`OpenableIcon`, `OpenableEntry.icon` removed), `src/modules/harness/artifact_open.ts` (`iconForPath` and the four hardcoded `icon` call sites removed).
- **Design system**: `src/lib/design_system.ts` gains `GLYPHS.arrowUpRight` (`↗`, verified single-cell in opentui's layout engine, so the fixed-gutter and no-emoji constraints hold).
- **Tests**: `src/tui/theme_contrast.render.test.tsx` generalized; `openable_card_block.render.test.tsx` blind spot fixed; `ask_prompt.render.test.tsx` and `presentation_block.render.test.tsx` extended for the new layouts.
- **Docs**: `cli/CLAUDE.md` TUI authoring rules; `docs/color_contrast_audit.md` updated to record that the defect class extends to plain `<text>`.
- **Persistence**: `Part` rows are stored as JSON blobs, so previously-written rows carrying a now-unread `icon` key must still read back cleanly. The design phase confirms the read path does not reject unknown keys before the deletion is committed.
- **No new dependencies.** No harness contract changes.
