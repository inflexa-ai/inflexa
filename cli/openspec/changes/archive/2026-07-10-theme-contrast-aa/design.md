## Context

The audit (`docs/color_contrast_audit.md`) established three facts. First, three rendering paths leak opentui's built-in default foreground (`#FFFFFF`): un-captured spans resolve the syntax scope `"default"`, which our `SyntaxStyle` never registers (`theme.ts:73`, styles from `design_system.ts`); `tool_block.tsx:63` mounts `<code>` without `fg`; `diff_block.tsx:30` mounts `<diff>` with no color props (opentui's DiffRenderable then also uses hardcoded dark bands `#1a4d1a`/`#4d1a1a`, `#888888` line numbers, `#22c55e`/`#ef4444` signs). Second, 173 of 400 rendered (token, background) pairs fail WCAG 2.1 AA in at least one of the ten built-in themes — `fgSubtle` and `border` in all ten. Third, `app.tsx`'s light-theme selection flattens the background to `bgActive` while keeping each token's foreground, so `bgActive` is a background every text token must survive, not just an interaction accent.

Constraints: no new dependencies; component code already reads all colors via `theme().<role>` (the audit found zero inline hexes in components — the violations are palette values plus the three opentui-boundary leaks).

## Goals / Non-Goals

**Goals:**

- No rendered text can fall through to an opentui built-in color in any theme.
- Every rendered (token, background) pair meets AA — 4.5:1 text, 3:1 non-text — in all ten themes, enforced by a test that fails on regression.
- Each theme keeps its recognizable identity (hue character) through the retune.
- The three-tier foreground hierarchy stays visually meaningful.

**Non-Goals:**

- Auditing or theming the text-command (non-TUI) output paths — TUI only, matching the audit's scope.
- Pixel-identical fidelity to upstream palettes (solarized-light / catppuccin-latte cannot reach AA unchanged; accepted).
- A user-facing "high contrast" toggle or custom-theme support — out of scope.
- Patching opentui itself; the `"default"` scope and per-renderable props are its designed embedder hooks.

## Decisions

### D1 — Fix the fallback at the SyntaxStyle, plus explicit `fg` at the two bare renderables

Register `default: { fg: c.fg }` in `markdownStyles()`. This is opentui's designed hook: `treeSitterToTextChunks` and the Markdown renderable's `createChunk`/table cells all resolve `getStyle("default")` before falling back to the renderable default (verified in `@opentui/core` 0.4.0). It is also the **only** lever for markdown tables — the Markdown renderable constructs its `TextTableRenderable` child without forwarding `fg`, so no prop we pass can reach table cells.

The scope alone is insufficient for `<code>`: when tree-sitter yields zero highlights (filetype `"text"`), `CodeRenderable` calls `textBuffer.setText()` and paints with the renderable's own default fg, bypassing chunk styling entirely. So `tool_block.tsx` passes `fg={theme().fg}` and `diff_block.tsx` passes `fg={theme().fg}` + `syntaxStyle={syntaxStyle()}` as well. Alternative rejected: passing `fg` everywhere without the scope — leaves tables white and every future call site one forgotten prop away from the same bug.

### D2 — Minimal diff token group

`ThemeColors` gains `diffAddedBg` and `diffRemovedBg` only. Signs map to existing `success`/`error`, line numbers to `fgMuted` — passed as props by `diff_block.tsx`. Rationale: a diff row band is a genuinely new surface no existing role expresses (the audit's one justified vocabulary extension, mirroring opencode's diff token group); everything else already has a semantic owner, and more tokens would dilute the vocabulary. Band values are per-theme tints of `success`/`error` toward `bg`, dark and light variants alike; text-on-band pairs join the contrast matrix.

### D3 — `fgSubtle` demoted to decorative-only, floored at 3:1

Retuning `fgSubtle` to 4.5:1 collapses the hierarchy: tokyo-night's AA `fgSubtle` would be `#8b8fa2` against a retuned `fgMuted` `#898fac` — two indistinguishable grays. Instead `fgSubtle`'s contract narrows to content whose loss does not impair task completion (unselected gutter glyphs, separator dots), floored at ≥3:1 so it stays perceivable; WCAG 1.4.3 exempts pure decoration. Every information-bearing call site — keybind hints, durations, ids, message meta, queued step labels — moves to `fgMuted`, which is retuned to ≥4.5:1 on all its surfaces. The classification rule lands in the spec so the boundary is enforceable in review.

### D4 — Hue-locked OKLCH retune, targeted at each token's worst rendered surface

Each failing token is adjusted in OKLCH by moving lightness only (hue held; chroma reduced only when the lightness axis alone cannot reach the target within gamut), until the pair clears its threshold on **every** background it renders against: `bg` always; `bgRaised`/`bgActive` per the audit's surface inventory (light-theme selection makes `bgActive` universal for text tokens). Ordering matters for cross-pairs: accents darken before `onAccent` is judged — the audit's two "unreachable" `onAccent` cases resolve themselves once their accent moves. The OKLCH math lives in a throwaway script; only final hex literals land in `design_system.ts` (no runtime dependency). Alternative rejected: the audit's RGB-blend suggestions — they desaturate toward gray and cost more identity than a lightness-only move.

Identity gate: design-gallery pass in at least one dark and one light theme comparing before/after, plus the default-theme look staying recognizably Tokyo Night. The `theme-system` spec's "byte-for-byte unchanged default look" claim is amended — it is exactly what this change revises.

### D5 — The pair matrix becomes a test

`src/lib/design_system.contrast.test.ts` encodes the audit's inventory — which token renders on which backgrounds at which threshold — and asserts every pair × every theme. WCAG relative-luminance math is ~15 lines, implemented in the test (no dependency). The inventory is data in one table, so adding a surface is a one-line diff. This converts the spec's contrast requirement from prose into a regression gate: any future palette edit or new theme that breaks AA fails `bun test`.

Trade-off: the inventory can drift from reality when a component starts rendering a token on a new background. Mitigation: the spec requirement makes "rendered pair not in the matrix" a review-time violation, and the matrix rows carry the component file references so stale rows are auditable.

## Risks / Trade-offs

- [Visual regression across ten themes] → gallery before/after pass (dark + light), hue-locked adjustments only, default theme reviewed explicitly.
- [Upstream palette fidelity lost for solarized-light / catppuccin-latte] → accepted by decision; deviation documented in the spec delta so future "sync with upstream" work knows it is deliberate.
- [Contrast matrix drifts from rendered reality] → spec rule + file-referenced rows (D5); the audit doc records the derivation method for re-runs.
- [opentui internals change under us (scope resolution, table fg forwarding)] → the contrast test doesn't cover opentui-internal fallbacks; `theme.test.ts` gains an assertion that every theme's `SyntaxStyle` resolves a `"default"` style, which fails loudly if the registration path breaks.
- [fgSubtle→fgMuted swaps change perceived emphasis in blocks] → swaps reviewed against the design gallery's type-scale section; the gallery remains the arbiter of tiers.

## Migration Plan

Single branch, four commits, green at the end: (1) fallback fixes (`default` scope + `<code>`/`<diff>` props), (2) diff token group + themed diff props, (3) `fgSubtle` demotion + call-site swaps, (4) palette retune + contrast test. No data or config migration; visual-only breaking change shipped as one release note line.

## Open Questions

_None blocking. The `border` 3:1 target is decided (frames carry block structure, so they are not waived as decorative); per-theme final hexes are implementation output validated by the test, not design-time constants._
