## 1. Fallback fixes — no text can fall through to opentui defaults (commit 1)

- [x] 1.1 Register `default: { fg: c.fg }` in `markdownStyles()` (`src/lib/design_system.ts`) so un-captured spans (markdown table data cells, plain fenced-block text) resolve to the theme foreground
- [x] 1.2 Pass `fg={theme().fg}` to the `<code>` in `src/tui/components/tool_block.tsx` (zero-highlight results paint via `setText()` with the renderable's own default fg, so the prop is required in addition to 1.1)
- [x] 1.3 Pass `fg={theme().fg}` and `syntaxStyle={syntaxStyle()}` to the `<diff>` in `src/tui/components/diff_block.tsx`
- [x] 1.4 Extend `src/tui/theme.test.ts`: for every built-in theme, `syntaxStyle()` resolves a `"default"` scope whose foreground equals that theme's `fg`
- [x] 1.5 Verify with the headless harness (`testRender`/`captureCharFrame` per cli/CLAUDE.md): a markdown pipe table and a plain-text tool result render readable cell/row text under a light theme (no white-on-light)

## 2. Diff token group — themed bands, signs, line numbers (commit 2)

- [x] 2.1 Add `diffAddedBg`/`diffRemovedBg` to `ThemeColors` with JSDoc contracts, and define values in all ten themes (per-theme tints of `success`/`error` toward `bg`; light themes get light tints, not opentui's dark bands)
- [x] 2.2 Pass `addedBg`/`removedBg`/`addedSignColor={theme().success}`/`removedSignColor={theme().error}`/`lineNumberFg={theme().fgMuted}` to the `<diff>` in `diff_block.tsx`
- [x] 2.3 Verify the DiffBlock gallery exhibit shows themed bands in a dark and a light theme (no `#1a4d1a`/`#4d1a1a`/`#888888` visible)

## 3. fgSubtle demotion — decorative only (commit 3)

- [x] 3.1 Narrow the `fgSubtle` JSDoc contract in `design_system.ts` (decorative only, ≥3:1 floor; information-bearing text uses `fgMuted` or stronger)
- [x] 3.2 Swap information-bearing `fgSubtle` call sites to `fgMuted`: `message_block.tsx:52` (message meta), `run_block.tsx` (tag, progress count, esc/ctrl+c hints), `run_card_block.tsx` (step count, run id), `plan_card_block.tsx` (step ids, plan id), `thinking_block.tsx` (duration, collapsed preview), `tool_block.tsx` (duration), `chat_bar.tsx:79` (newline hint), `welcome.tsx:37` (hints), `boot_indicator.tsx` (elapsed), `diff_block.tsx:32` (stats hint)
- [x] 3.3 Keep genuinely decorative sites on `fgSubtle` (unselected list gutter in `list_core.tsx:257`, queued-step label in `run_block.tsx:69` if judged decorative — decide against the gallery's type-scale section) and record the classification in the gallery exhibit descriptions where ambiguous
- [x] 3.4 Verify the design gallery's emphasis/type-scale section still shows three visually distinct tiers

## 4. Palette retune + contrast test — AA everywhere, identity kept (commit 4)

- [x] 4.1 Write the retune script (scratch, not shipped): OKLCH hue-locked lightness moves per failing token until it clears its threshold on every background in its surface set (`bg` always; `bgRaised`/`bgActive` per the audit inventory; `fgSubtle` targets 3:1); adjust accents before judging `onAccent` cross-pairs
- [x] 4.2 Land retuned hex values in `design_system.ts` for all ten themes (audit Appendix A lists the failing tokens per theme; final values come from 4.1, not the appendix's RGB-blend suggestions)
- [x] 4.3 Add `src/lib/design_system.contrast.test.ts`: the rendered pair matrix as data (each row: fg token, bg token(s), threshold, component reference) × all themes, WCAG luminance math inline, failing output names theme/pair/ratio
- [x] 4.4 Include the D2 band pairs (diff text on `diffAddedBg`/`diffRemovedBg`) and the filled pairs (`onAccent` on `accent` and on `error`) in the matrix
- [x] 4.5 Identity pass: design gallery before/after in `tokyo-night` and one light theme (`github-light`), confirming hue character is preserved; default theme reviewed explicitly
- [x] 4.6 Full gate: `bun run typecheck`, `bun run lint`, `bun test` green; `bun run format:file` on touched `src/` files

## 5. Wrap-up

- [x] 5.1 Update `docs/color_contrast_audit.md` status header: fixes landed, matrix enforced by `design_system.contrast.test.ts` (keep the audit as the derivation record)
- [x] 5.2 Confirm all spec-delta scenarios hold (opsx:verify) — un-captured spans themed, diff themed both modes, info-bearing text ≥4.5:1, matrix test green
