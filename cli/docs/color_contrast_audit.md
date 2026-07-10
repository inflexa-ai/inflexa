# Theme color-contrast audit (WCAG 2.1 AA)

**Date:** 2026-07-10 · **Scope:** `cli/src/tui/**` + `cli/src/lib/design_system.ts` (all 10 registry themes) · **Status: RESOLVED — fixes landed via the OpenSpec change `theme-contrast-aa`; the pair matrix is now permanently enforced by `src/lib/design_system.contrast.test.ts`.** This document is kept as the derivation record: how the failures were found and measured. The ratios and Appendix A/B values below describe the state AT AUDIT TIME, before the fixes.

Method: every `(foreground, background)` pair the TUI actually renders was inventoried by reading the components (`fg=`/`bg=`/`backgroundColor`/`<Fg role>`/marker roles), the opentui 0.4.0 rendering internals (`@opentui/core` `Markdown`/`Code`/`TextTable`/`Diff` renderables) were traced for their fallback colors, and WCAG 2.1 relative-luminance contrast ratios were computed programmatically for all pairs across all 10 themes (400 pairs). Thresholds: **4.5:1** for text, **3:1** for non-text UI (borders, focus indicators). The reference screenshots were pixel-sampled to confirm the failing color is exactly `#ffffff` (opentui's built-in default foreground), while section headers track the theme accent — theme-aware in both modes.

> Note on the "MUI theming" standard: this app is a terminal UI with its own semantic token system (`ThemeColors` in `design_system.ts`), which is the moral equivalent of the MUI palette. The mapping used throughout: `text.primary → fg`, `text.secondary → fgMuted`, `palette.<color>.main → accent/secondary/success/warning/error/info`, `getContrastText() → onAccent`. The audit applies the same rule MUI's guidance encodes: every rendered color must come from a token that is defined and verified **for both palette modes** — never a hardcoded or single-mode value.

---

## Root cause of the invisible data rows

Tool results (e.g. the data-profile report in the screenshots) are rendered by `tool_block.tsx:63` as a bare `<code …>` with **no `fg` prop**, and chat-markdown pipe tables reach opentui's `TextTableRenderable`, which the Markdown renderable constructs **without forwarding any `fg`**. In both paths, any span that has no tree-sitter capture resolves `syntaxStyle.getStyle("default")` — and our `SyntaxStyle.fromStyles({...syntax, ...markdownStyles})` (`theme.ts:73`, styles from `design_system.ts:189-213`) **never registers a `"default"` scope** — so the text falls through to opentui's built-in default foreground, `#FFFFFF`. Headings and table-header cells are styled through `markup.heading` → our theme `accent`, which is why they recolor correctly per theme while the plain data rows stay pure white: ~17:1 on a dark background, **1.00–1.13:1 (invisible) on every light theme**.

(The screenshot pixel values — data rows exactly `#ffffff`, headers on the accent channel — match this diagnosis exactly. The screenshots' accent/bg hexes don't correspond to the current registry palettes, so they were presumably taken on an earlier palette iteration, but the defect reproduces structurally with today's palettes.)

The same defect family has a third member: `diff_block.tsx:30` renders `<diff diff={…}/>` with **no `fg`, no `syntaxStyle`, no color props at all**, so the DiffRenderable's internal Code children default every diff line to `#FFFFFF` and use opentui's hardcoded dark-palette defaults (`addedBg #1a4d1a`, `removedBg #4d1a1a`, `lineNumberFg #888888`, signs `#22c55e`/`#ef4444`) in **both** modes.

---

## Violations — representative table

Representative themes: **light = `github-light`**, **dark = `tokyo-night`** (the default). "AA L/D" = pass/fail for light/dark. Per-theme numbers for all 10 themes are in Appendix A/B — several violations below are worse in other themes (e.g. `solarized-light` fails on 24 tokens including body text).

| file:line | context | current color | resolved light | resolved dark | light ratio | dark ratio | AA L/D | recommended token fix |
|---|---|---|---|---|---|---|---|---|
| `src/tui/components/tool_block.tsx:63` | tool-result `<code>` — un-captured text (data-profile reports; **the screenshot bug**) | opentui default (no `fg` passed) | `#ffffff` on `#f6f8fa` | `#ffffff` on `#1f2335` | **1.06:1** | 15.55:1¹ | **FAIL** / pass¹ | pass `fg={theme().fg}` on the `<code>`; register `default: { fg: c.fg }` in `markdownStyles()` |
| `src/tui/layout/message_block.tsx:69` | chat markdown pipe-table **data cells** (TextTable child gets no fg) | opentui `TextTableRenderable` default `fg: "#FFFFFF"` | `#ffffff` on `#ffffff` | `#ffffff` on `#1a1b26` | **1.00:1** | 17.09:1¹ | **FAIL** / pass¹ | register `default: { fg: c.fg }` in `markdownStyles()` (`design_system.ts:189`) — the only embedder-side lever; opentui never forwards fg to tables |
| `src/tui/components/diff_block.tsx:30` | `<diff>` context lines (no props passed) | opentui default `#FFFFFF` | `#ffffff` on `#ffffff` | `#ffffff` on `#1a1b26` | **1.00:1** | 17.09:1¹ | **FAIL** / pass¹ | pass `fg={theme().fg}` + `syntaxStyle={syntaxStyle()}` to `<diff>` |
| `src/tui/components/diff_block.tsx:30` | `<diff>` added/removed row background | hardcoded `#1a4d1a` / `#4d1a1a` (dark-only design) | `#ffffff` on `#1a4d1a` | same | 9.90:1² | 9.90:1 | pass² | theme the bands: add `diffAddedBg`/`diffRemovedBg` tokens (opencode has these; no existing role fits — justified new tokens) |
| `src/tui/components/diff_block.tsx:30` | `<diff>` line numbers | hardcoded `#888888` | `#888888` on `#ffffff` | `#888888` on `#1a1b26` | **3.54:1** | 4.82:1 | **FAIL** / pass | pass `lineNumberFg={theme().fgMuted}` (after fgMuted retune below) |
| `src/tui/components/diff_block.tsx:30` | `<diff>` +/− sign column | hardcoded `#22c55e` / `#ef4444` | `#22c55e` on `#ffffff` | `#22c55e` on `#1a1b26` | **2.28:1** | 7.50:1 | **FAIL** / pass | pass `addedSignColor={theme().success}` / `removedSignColor={theme().error}` |
| `src/lib/design_system.ts` (`fgSubtle`, all themes) | hints users must read: `welcome.tsx:37`, `message_block.tsx:52`, `run_block.tsx:75`, `chat_bar.tsx:79`, `list_core.tsx:257`, `thinking_block.tsx:37` | theme token (fails in **10/10** themes) | `#8c959f` on `#ffffff` | `#3b4261` on `#1a1b26` | **3.04:1** | **1.74:1** | **FAIL / FAIL** | retune per theme to ≥4.5:1 on `bg` **and** `bgActive` (Appendix A values), or demote to decorative-only and switch these call sites to `fgMuted` |
| `src/lib/design_system.ts` (`fgMuted`, 8/10 themes) | labels/meta/placeholders: `status_bar.tsx:39/46`, `dialog_panel.tsx:62`, `text_area.tsx:108`, `list_core.tsx:309`, sidebar | theme token | `#57606a` on `#ffffff` | `#565f89` on `#1a1b26` | 6.39:1 | **2.76:1** | pass / **FAIL** | retune failing themes (Appendix A); worst surface is `bgActive` (placeholder in focused editor) |
| `src/lib/design_system.ts` (`border`, all themes) | panel frames: `diff_block.tsx:29`, `tool_block.tsx:60`, `sidebar.tsx:164`, `run_block.tsx:62` | theme token (UI, 3:1) | `#d0d7de` on `#ffffff` | `#414868` on `#1a1b26` | **1.45:1** | **1.91:1** | **FAIL / FAIL** | retune per theme to ≥3:1 (Appendix A) — or accept as decorative if frames are deemed non-essential (they currently carry block structure) |
| `src/lib/design_system.ts` (`syntax.comment`, 8/10) | code-block comments in chat | theme token | `#6e7781` on `#ffffff` | `#565f89` on `#1a1b26` | 4.55:1 | **2.76:1** | pass / **FAIL** | retune per theme (Appendix A) |
| `src/lib/design_system.ts` (light themes' saturated roles) | `info`/`success`/`warning`/`thinking`/`accent`/syntax on light `bg` — md links, diff counts, status tones, headings | theme tokens | e.g. latte `#04a5e5` on `#eff1f5` | (dark themes largely pass) | **2.30–4.46:1** | mostly pass | **FAIL** / pass | darken per theme (Appendix A): `catppuccin-latte` 20 tokens, `solarized-light` 24 (incl. body `fg` 4.13:1), `one-light` 17, `gruvbox-light` 14 |
| `src/tui/components/chat.tsx:112-113` | error banner: `onAccent` on `error` background | theme tokens (`onAccent` is tuned for `accent`, reused on `error`) | `#ffffff` on `#cf222e` | `#1a1b26` on `#f7768e` | 5.36:1 | 6.46:1 | pass / pass³ | fails in `gruvbox-dark` (4.29), `nord` (3.05), `gruvbox-light` (3.33): resolve contrast per filled role (`getContrastText` equivalent) instead of reusing `onAccent`, or retune those themes' `error` (Appendix A) |
| `src/tui/layout/status_bar.tsx:42`, `app.tsx:445-451` | status tones / notices on `bgRaised` | theme tokens | latte `warning #df8e1d` on `#e6e9ef` | nord `error #bf616a` on `#272c36` | **2.15:1** | **3.42:1** | **FAIL / FAIL** (theme-dep.) | covered by the per-theme retunes: every status role must clear 4.5:1 on `bg` **and** `bgRaised` |

¹ Passes the ratio check on dark themes but is still a defect: the color is unthemed `#FFFFFF`, not `theme().fg` — it ignores every palette (e.g. tokyo-night body text is `#c0caf5`).
² White-on-dark-band is readable, but the hardcoded dark bands are a single-mode design: on light themes a dark-green/dark-red slab appears inside a white UI.
³ Representative themes pass; the failure is theme-dependent — see Appendix B.

Not violations (verified intentional): `text_area.tsx:112` / `text_input.tsx:99` set the busy cursor to `theme().bg` (deliberately hides the cursor while input is gated); `<Reverse>` selection swaps fg/bg (ratio unchanged); dark themes' native selection inverts per-token (ratio preserved). Derived constraint from `app.tsx:241-249`: light themes flatten selection to `bgActive` while keeping token fg, so every text token must also pass against `bgActive` — folded into the matrix and the Appendix A targets.

---

## Prioritized fix list

**P0 — fully invisible text in light themes (ratio ≈ 1:1):**
1. Register `default: { fg: c.fg }` in `markdownStyles()` (`design_system.ts:189`). One line; fixes markdown-table data cells everywhere and every "un-captured span" fallback. This mirrors the reference implementation (opencode registers `scope: ["default"] → theme.text` in its TUI theme).
2. `tool_block.tsx:63`: pass `fg={theme().fg}` to the `<code>`. Required in addition to (1): when tree-sitter yields **zero** highlights (filetype "text"), CodeRenderable calls `textBuffer.setText()` and paints with the renderable's own default fg, bypassing the `"default"` scope.
3. `diff_block.tsx:30`: pass `fg={theme().fg}` and `syntaxStyle={syntaxStyle()}` to `<diff>` (context lines are invisible in light themes today).

**P1 — unreadable-tier tokens (systemic, all/most themes):**
4. `fgSubtle`: fails 4.5:1 in **all 10 themes** (1.36–3.04:1) yet is used for content users must read (hints, durations, ids). Either retune to the Appendix A values, or formally demote it to decorative-only and move information-bearing call sites to `fgMuted`.
5. `fgMuted`: fails in 8/10 themes, worst on `bgActive` (focused-editor placeholder). Retune per Appendix A.
6. `border` (3:1 non-text): fails in **all 10 themes**. Retune per Appendix A.

**P2 — single-mode / hardcoded diff colors:**
7. Theme the `<diff>` band and sign colors. No existing role fits a diff row band, so add the small token group the reference uses (`diffAddedBg`, `diffRemovedBg`, plus sign/lineNumber roles mapped to `success`/`error`/`fgMuted`) — the one place new tokens are justified.

**P3 — per-theme palette retunes for AA (mostly light themes):**
8. Apply Appendix A's suggested values (same hue, minimal shift to clear the worst background each token renders on): `solarized-light` (24 tokens — including body `fg` at 4.13:1), `catppuccin-latte` (20), `one-light` (17), `gruvbox-light` (14), `nord` (9), `gruvbox-dark` (8), `rose-pine` (6), `tokyo-night` (4), `catppuccin-mocha` (4), `github-light` (2). Decision needed: these deviate from the canonical upstream palettes — strict AA and palette fidelity conflict for solarized/latte especially.
9. Re-verify cross-pairs after (8): `onAccent`-on-`accent` failures (latte, gruvbox-light "UNREACHABLE") self-resolve once `accent` darkens; the `chat.tsx` error banner should then be re-checked per theme, or switched to a computed contrast text per filled role.

**Ordering note:** P0 items are two one-line prop additions plus one style entry — they fix the reported bug outright and are safe in all 10 themes (the `"default"` scope only affects spans that previously fell through to `#FFFFFF`).

---

## Definition-of-done check (at audit time — since resolved by `theme-contrast-aa`)

- ✗→✓ Every rendered text/background pair meets AA in both modes — **173 of 400 theme-pairs failed** at audit time (Appendix B); the expanded 500-pair matrix now passes in all ten themes, enforced by `design_system.contrast.test.ts`.
- ✗→✓ No hardcoded colors in audited paths — three opentui call sites leaked unthemed defaults (`tool_block.tsx:63`, `message_block.tsx:69` via TextTable, `diff_block.tsx:30`); all three now pass themed props, and the `"default"` syntax scope closes the fallback. Component-authored colors were already 100% token-based (the `never inline hex` rule holds).
- ✗→✓ Data rows readable in light themes — restored by the P0 fixes; pinned by `theme_contrast.render.test.tsx` (per-span color assertions under `github-light`).

---

## Appendix A — suggested AA-passing token values per theme

Computed as the minimal same-hue shift (RGB blend toward black/white) that clears the required ratio on **every** background the token renders against (`bg`, and where applicable `bgRaised`/`bgActive`; `onAccent` against `accent`+`error`). Suggestions are starting points for the fix pass, not final design values.

```

tokyo-night (dark) — 4 tokens need adjustment:
  fgMuted            #565f89 (worst 2.35:1) -> #898fac (worst 4.57:1, shift 30%)
  fgSubtle           #3b4261 (worst 1.48:1) -> #8b8fa2 (worst 4.54:1, shift 41%)
  border             #414868 (worst 1.91:1) -> #616782 (worst 3.07:1, shift 17%)
  syntax.comment     #565f89 (worst 2.76:1) -> #7b82a3 (worst 4.53:1, shift 22%)

catppuccin-mocha (dark) — 4 tokens need adjustment:
  fgMuted            #6c7086 (worst 2.57:1) -> #989baa (worst 4.55:1, shift 30%)
  fgSubtle           #585b70 (worst 1.88:1) -> #999ba8 (worst 4.56:1, shift 39%)
  border             #45475a (worst 1.80:1) -> #686a79 (worst 3.07:1, shift 19%)
  syntax.comment     #6c7086 (worst 3.36:1) -> #848799 (worst 4.61:1, shift 16%)

gruvbox-dark (dark) — 8 tokens need adjustment:
  fgMuted            #928374 (worst 3.16:1) -> #aba094 (worst 4.52:1, shift 23%)
  fgSubtle           #665c54 (worst 1.78:1) -> #a8a29e (worst 4.60:1, shift 43%)
  secondary          #83a598 (worst 4.31:1) -> #88a99c (worst 4.53:1, shift 4%)
  error              #fb4934 (worst 4.29:1) -> #fb5440 (worst 4.52:1, shift 6%)
  border             #504945 (worst 1.67:1) -> #77716e (worst 3.07:1, shift 22%)
  onAccent           #282828 (worst 4.29:1) -> #242424 (worst 4.51:1, shift 9%)
  syntax.keyword     #fb4934 (worst 4.29:1) -> #fb5440 (worst 4.52:1, shift 6%)
  syntax.comment     #928374 (worst 4.02:1) -> #9a8c7e (worst 4.51:1, shift 7%)

nord (dark) — 9 tokens need adjustment:
  fgMuted            #616e88 (worst 1.96:1) -> #a7aebc (worst 4.52:1, shift 44%)
  fgSubtle           #4c566a (worst 1.36:1) -> #a9aeb7 (worst 4.52:1, shift 52%)
  secondary          #81a1c1 (worst 3.74:1) -> #96b1cc (worst 4.53:1, shift 17%)
  assistant          #b48ead (worst 4.41:1) -> #b690af (worst 4.52:1, shift 2%)
  error              #bf616a (worst 3.05:1) -> #cf898f (worst 4.54:1, shift 25%)
  border             #434c5e (worst 1.45:1) -> #787e8b (worst 3.07:1, shift 28%)
  onAccent           #2e3440 (worst 3.05:1) -> #121419 (worst 4.50:1, shift 61%)
  syntax.comment     #616e88 (worst 2.43:1) -> #949cae (worst 4.54:1, shift 32%)
  syntax.number      #b48ead (worst 4.41:1) -> #b690af (worst 4.52:1, shift 2%)

rose-pine (dark) — 6 tokens need adjustment:
  fgMuted            #6e6a86 (worst 2.94:1) -> #8e8ba1 (worst 4.59:1, shift 22%)
  fgSubtle           #524f67 (worst 1.93:1) -> #8d8b9b (worst 4.55:1, shift 34%)
  success            #31748f (worst 2.91:1) -> #6094a9 (worst 4.56:1, shift 23%)
  border             #403d52 (worst 1.69:1) -> #666475 (worst 3.06:1, shift 20%)
  syntax.keyword     #31748f (worst 3.38:1) -> #5089a0 (worst 4.56:1, shift 15%)
  syntax.comment     #6e6a86 (worst 3.42:1) -> #827f97 (worst 4.57:1, shift 14%)

catppuccin-latte (light) — 20 tokens need adjustment:
  fgMuted            #8c8fa1 (worst 2.07:1) -> #575964 (worst 4.51:1, shift 38%)
  fgSubtle           #9ca0b0 (worst 1.69:1) -> #565861 (worst 4.59:1, shift 45%)
  accent             #1e66f5 (worst 3.18:1) -> #1851c2 (worst 4.54:1, shift 21%)
  secondary          #8839ef (worst 3.51:1) -> #7230c9 (worst 4.56:1, shift 16%)
  info               #04a5e5 (worst 2.30:1) -> #03709c (worst 4.54:1, shift 32%)
  user               #04a5e5 (worst 2.47:1) -> #0375a3 (worst 4.55:1, shift 29%)
  tool               #04a5e5 (worst 2.47:1) -> #0375a3 (worst 4.55:1, shift 29%)
  thinking           #df8e1d (worst 2.31:1) -> #986114 (worst 4.58:1, shift 32%)
  success            #40a02b (worst 2.17:1) -> #29661c (worst 4.52:1, shift 36%)
  warning            #df8e1d (worst 2.15:1) -> #915c13 (worst 4.61:1, shift 35%)
  error              #d20f39 (worst 4.46:1) -> #d00f38 (worst 4.53:1, shift 1%)
  border             #bcc0cc (worst 1.61:1) -> #878a93 (worst 3.05:1, shift 28%)
  onAccent           #eff1f5 (worst 4.34:1) -> #f4f5f8 (worst 4.51:1, shift 29%)
  syntax.string      #40a02b (worst 2.96:1) -> #327d22 (worst 4.54:1, shift 22%)
  syntax.comment     #7c7f93 (worst 3.49:1) -> #6b6d7e (worst 4.51:1, shift 14%)
  syntax.number      #fe640b (worst 2.64:1) -> #bc4a08 (worst 4.51:1, shift 26%)
  syntax.function    #1e66f5 (worst 4.34:1) -> #1d63ee (worst 4.56:1, shift 3%)
  syntax.type        #df8e1d (worst 2.31:1) -> #986114 (worst 4.58:1, shift 32%)
  syntax.operator    #04a5e5 (worst 2.47:1) -> #0375a3 (worst 4.55:1, shift 29%)
  syntax.punctuation #7c7f93 (worst 3.49:1) -> #6b6d7e (worst 4.51:1, shift 14%)

github-light (light) — 2 tokens need adjustment:
  fgSubtle           #8c959f (worst 2.73:1) -> #697077 (worst 4.51:1, shift 25%)
  border             #d0d7de (worst 1.45:1) -> #909499 (worst 3.05:1, shift 31%)

solarized-light (light) — 24 tokens need adjustment:
  fg                 #657b83 (worst 3.64:1) -> #586b72 (worst 4.56:1, shift 13%)
  fgMuted            #93a1a1 (worst 2.18:1) -> #616a6a (worst 4.54:1, shift 34%)
  fgSubtle           #b0b8b8 (worst 1.65:1) -> #646969 (worst 4.55:1, shift 43%)
  accent             #268bd2 (worst 3.00:1) -> #1e6ca4 (worst 4.59:1, shift 22%)
  secondary          #6c71c4 (worst 3.57:1) -> #5d61a9 (worst 4.57:1, shift 14%)
  info               #2aa198 (worst 2.58:1) -> #1e746d (worst 4.54:1, shift 28%)
  user               #2aa198 (worst 2.93:1) -> #217e77 (worst 4.51:1, shift 22%)
  assistant          #6c71c4 (worst 4.06:1) -> #666ab8 (worst 4.51:1, shift 6%)
  tool               #2aa198 (worst 2.93:1) -> #217e77 (worst 4.51:1, shift 22%)
  thinking           #b58900 (worst 2.98:1) -> #8f6c00 (worst 4.51:1, shift 21%)
  success            #859900 (worst 2.62:1) -> #606e00 (worst 4.60:1, shift 28%)
  warning            #b58900 (worst 2.62:1) -> #846400 (worst 4.51:1, shift 27%)
  error              #dc322f (worst 3.77:1) -> #c42d2a (worst 4.56:1, shift 11%)
  border             #93a1a1 (worst 2.48:1) -> #849191 (worst 3.02:1, shift 10%)
  onAccent           #fdf6e3 (worst 3.41:1) -> #000000 (worst 4.54:1, shift 100%)
  syntax.keyword     #859900 (worst 2.97:1) -> #687700 (worst 4.61:1, shift 22%)
  syntax.string      #2aa198 (worst 2.93:1) -> #217e77 (worst 4.51:1, shift 22%)
  syntax.comment     #93a1a1 (worst 2.48:1) -> #687272 (worst 4.59:1, shift 29%)
  syntax.number      #d33682 (worst 4.21:1) -> #c8337c (worst 4.61:1, shift 5%)
  syntax.function    #268bd2 (worst 3.41:1) -> #2076b3 (worst 4.52:1, shift 15%)
  syntax.type        #b58900 (worst 2.98:1) -> #8f6c00 (worst 4.51:1, shift 21%)
  syntax.variable    #657b83 (worst 4.13:1) -> #5f747b (worst 4.56:1, shift 6%)
  syntax.operator    #859900 (worst 2.97:1) -> #687700 (worst 4.61:1, shift 22%)
  syntax.punctuation #657b83 (worst 4.13:1) -> #5f747b (worst 4.56:1, shift 6%)

gruvbox-light (light) — 14 tokens need adjustment:
  fgMuted            #7c6f64 (worst 2.84:1) -> #5b5149 (worst 4.50:1, shift 27%)
  fgSubtle           #a89984 (worst 1.62:1) -> #595146 (worst 4.55:1, shift 47%)
  accent             #b57614 (worst 2.20:1) -> #724a0d (worst 4.53:1, shift 37%)
  secondary          #076678 (worst 3.85:1) -> #065b6b (worst 4.51:1, shift 11%)
  success            #79740e (worst 2.83:1) -> #58550a (worst 4.50:1, shift 27%)
  warning            #af3a03 (worst 4.46:1) -> #ad3903 (worst 4.55:1, shift 1%)
  border             #bdae93 (worst 1.92:1) -> #958974 (worst 3.03:1, shift 21%)
  onAccent           #fbf1c7 (worst 3.33:1) -> UNREACHABLE
  syntax.string      #79740e (worst 4.29:1) -> #746f0d (worst 4.60:1, shift 4%)
  syntax.comment     #7c6f64 (worst 4.29:1) -> #776b60 (worst 4.56:1, shift 4%)
  syntax.function    #427b58 (worst 4.40:1) -> #417956 (worst 4.52:1, shift 2%)
  syntax.type        #b57614 (worst 3.33:1) -> #966211 (worst 4.57:1, shift 17%)
  syntax.operator    #427b58 (worst 4.40:1) -> #417956 (worst 4.52:1, shift 2%)
  syntax.punctuation #7c6f64 (worst 4.29:1) -> #776b60 (worst 4.56:1, shift 4%)

one-light (light) — 17 tokens need adjustment:
  fgMuted            #a0a1a7 (worst 2.14:1) -> #68696d (worst 4.56:1, shift 35%)
  fgSubtle           #bcbcc2 (worst 1.57:1) -> #69696d (worst 4.55:1, shift 44%)
  accent             #4078f2 (worst 3.37:1) -> #3665cb (worst 4.50:1, shift 16%)
  info               #0184bc (worst 3.67:1) -> #0174a5 (worst 4.56:1, shift 12%)
  user               #0184bc (worst 4.00:1) -> #017baf (worst 4.52:1, shift 7%)
  tool               #0184bc (worst 4.00:1) -> #017baf (worst 4.52:1, shift 7%)
  thinking           #c18401 (worst 3.06:1) -> #9a6a01 (worst 4.54:1, shift 20%)
  success            #50a14f (worst 2.67:1) -> #3a763a (worst 4.56:1, shift 27%)
  warning            #c18401 (worst 2.81:1) -> #936401 (worst 4.54:1, shift 24%)
  error              #e45649 (worst 3.22:1) -> #bb473c (worst 4.52:1, shift 18%)
  border             #d1d1d2 (worst 1.46:1) -> #909091 (worst 3.06:1, shift 31%)
  onAccent           #fafafa (worst 3.51:1) -> #141414 (worst 4.55:1, shift 92%)
  syntax.string      #50a14f (worst 3.07:1) -> #40813f (worst 4.54:1, shift 20%)
  syntax.comment     #a0a1a7 (worst 2.47:1) -> #727277 (worst 4.58:1, shift 29%)
  syntax.function    #4078f2 (worst 3.88:1) -> #3a6ddc (worst 4.57:1, shift 9%)
  syntax.type        #c18401 (worst 3.06:1) -> #9a6a01 (worst 4.54:1, shift 20%)
  syntax.operator    #0184bc (worst 4.00:1) -> #017baf (worst 4.52:1, shift 7%)
```

## Appendix B — all failing pairs (WCAG 2.1 AA, 173 of 400 checked)

Format: theme · pair · colors · measured ratio (required) · rendering site.

```
tokyo-night	fgMuted on bg	#565f89 on #1a1b26	2.76:1 (need 4.5:1)	labels/meta, placeholders (text_area.tsx:108)
tokyo-night	fgSubtle on bg	#3b4261 on #1a1b26	1.74:1 (need 4.5:1)	hints (welcome.tsx:37, run_block.tsx:75, message_block.tsx:52)
tokyo-night	border on bg	#414868 on #1a1b26	1.91:1 (need 3:1)	panel frames (diff_block.tsx:29 …)
tokyo-night	syntax.comment on bg	#565f89 on #1a1b26	2.76:1 (need 4.5:1)	design_system.ts syntax.comment
tokyo-night	fgMuted on bgRaised	#565f89 on #1f2335	2.51:1 (need 4.5:1)	status_bar.tsx:39/46, dialog_panel.tsx:62, list_core.tsx:309
tokyo-night	fgMuted on bgActive	#565f89 on #24283b	2.35:1 (need 4.5:1)	focused editor placeholder (text_area.tsx:108)
tokyo-night	fgSubtle on bgActive	#3b4261 on #24283b	1.48:1 (need 4.5:1)	chat_bar.tsx:79 (blurred bar), list_core.tsx:257
catppuccin-mocha	fgMuted on bg	#6c7086 on #1e1e2e	3.36:1 (need 4.5:1)	labels/meta, placeholders (text_area.tsx:108)
catppuccin-mocha	fgSubtle on bg	#585b70 on #1e1e2e	2.46:1 (need 4.5:1)	hints (welcome.tsx:37, run_block.tsx:75, message_block.tsx:52)
catppuccin-mocha	border on bg	#45475a on #1e1e2e	1.80:1 (need 3:1)	panel frames (diff_block.tsx:29 …)
catppuccin-mocha	syntax.comment on bg	#6c7086 on #1e1e2e	3.36:1 (need 4.5:1)	design_system.ts syntax.comment
catppuccin-mocha	fgMuted on bgRaised	#6c7086 on #181825	3.59:1 (need 4.5:1)	status_bar.tsx:39/46, dialog_panel.tsx:62, list_core.tsx:309
catppuccin-mocha	fgMuted on bgActive	#6c7086 on #313244	2.57:1 (need 4.5:1)	focused editor placeholder (text_area.tsx:108)
catppuccin-mocha	fgSubtle on bgActive	#585b70 on #313244	1.88:1 (need 4.5:1)	chat_bar.tsx:79 (blurred bar), list_core.tsx:257
gruvbox-dark	fgMuted on bg	#928374 on #282828	4.02:1 (need 4.5:1)	labels/meta, placeholders (text_area.tsx:108)
gruvbox-dark	fgSubtle on bg	#665c54 on #282828	2.26:1 (need 4.5:1)	hints (welcome.tsx:37, run_block.tsx:75, message_block.tsx:52)
gruvbox-dark	error on bg	#fb4934 on #282828	4.29:1 (need 4.5:1)	error_block.tsx:42, diff_block.tsx:27
gruvbox-dark	border on bg	#504945 on #282828	1.67:1 (need 3:1)	panel frames (diff_block.tsx:29 …)
gruvbox-dark	syntax.keyword on bg	#fb4934 on #282828	4.29:1 (need 4.5:1)	design_system.ts syntax.keyword
gruvbox-dark	syntax.comment on bg	#928374 on #282828	4.02:1 (need 4.5:1)	design_system.ts syntax.comment
gruvbox-dark	fgMuted on bgRaised	#928374 on #1d2021	4.47:1 (need 4.5:1)	status_bar.tsx:39/46, dialog_panel.tsx:62, list_core.tsx:309
gruvbox-dark	fgMuted on bgActive	#928374 on #3c3836	3.16:1 (need 4.5:1)	focused editor placeholder (text_area.tsx:108)
gruvbox-dark	fgSubtle on bgActive	#665c54 on #3c3836	1.78:1 (need 4.5:1)	chat_bar.tsx:79 (blurred bar), list_core.tsx:257
gruvbox-dark	secondary on bgActive	#83a598 on #3c3836	4.31:1 (need 4.5:1)	list_core.tsx:259 (cursor row)
gruvbox-dark	onAccent on error	#282828 on #fb4934	4.29:1 (need 4.5:1)	chat.tsx:112-113 (error banner)
nord	fgMuted on bg	#616e88 on #2e3440	2.43:1 (need 4.5:1)	labels/meta, placeholders (text_area.tsx:108)
nord	fgSubtle on bg	#4c566a on #2e3440	1.69:1 (need 4.5:1)	hints (welcome.tsx:37, run_block.tsx:75, message_block.tsx:52)
nord	assistant on bg	#b48ead on #2e3440	4.41:1 (need 4.5:1)	message_block.tsx:50
nord	error on bg	#bf616a on #2e3440	3.05:1 (need 4.5:1)	error_block.tsx:42, diff_block.tsx:27
nord	border on bg	#434c5e on #2e3440	1.45:1 (need 3:1)	panel frames (diff_block.tsx:29 …)
nord	syntax.comment on bg	#616e88 on #2e3440	2.43:1 (need 4.5:1)	design_system.ts syntax.comment
nord	syntax.number on bg	#b48ead on #2e3440	4.41:1 (need 4.5:1)	design_system.ts syntax.number
nord	fgMuted on bgRaised	#616e88 on #272c36	2.73:1 (need 4.5:1)	status_bar.tsx:39/46, dialog_panel.tsx:62, list_core.tsx:309
nord	error on bgRaised	#bf616a on #272c36	3.42:1 (need 4.5:1)	status_bar.tsx:42 (tone), dialog_panel.tsx:51
nord	fgMuted on bgActive	#616e88 on #3b4252	1.96:1 (need 4.5:1)	focused editor placeholder (text_area.tsx:108)
nord	fgSubtle on bgActive	#4c566a on #3b4252	1.36:1 (need 4.5:1)	chat_bar.tsx:79 (blurred bar), list_core.tsx:257
nord	secondary on bgActive	#81a1c1 on #3b4252	3.74:1 (need 4.5:1)	list_core.tsx:259 (cursor row)
nord	onAccent on error	#2e3440 on #bf616a	3.05:1 (need 4.5:1)	chat.tsx:112-113 (error banner)
rose-pine	fgMuted on bg	#6e6a86 on #191724	3.42:1 (need 4.5:1)	labels/meta, placeholders (text_area.tsx:108)
rose-pine	fgSubtle on bg	#524f67 on #191724	2.25:1 (need 4.5:1)	hints (welcome.tsx:37, run_block.tsx:75, message_block.tsx:52)
rose-pine	success on bg	#31748f on #191724	3.38:1 (need 4.5:1)	diff_block.tsx:27, run_block.tsx:59
rose-pine	border on bg	#403d52 on #191724	1.69:1 (need 3:1)	panel frames (diff_block.tsx:29 …)
rose-pine	syntax.keyword on bg	#31748f on #191724	3.38:1 (need 4.5:1)	design_system.ts syntax.keyword
rose-pine	syntax.comment on bg	#6e6a86 on #191724	3.42:1 (need 4.5:1)	design_system.ts syntax.comment
rose-pine	fgMuted on bgRaised	#6e6a86 on #1f1d2e	3.20:1 (need 4.5:1)	status_bar.tsx:39/46, dialog_panel.tsx:62, list_core.tsx:309
rose-pine	success on bgRaised	#31748f on #1f1d2e	3.16:1 (need 4.5:1)	status_bar.tsx:42 (tone), sidebar.tsx:217
rose-pine	fgMuted on bgActive	#6e6a86 on #26233a	2.94:1 (need 4.5:1)	focused editor placeholder (text_area.tsx:108)
rose-pine	fgSubtle on bgActive	#524f67 on #26233a	1.93:1 (need 4.5:1)	chat_bar.tsx:79 (blurred bar), list_core.tsx:257
rose-pine	success on bgActive	#31748f on #26233a	2.91:1 (need 4.5:1)	list_core.tsx:257 (selected gutter)
catppuccin-latte	md table data cell (#ffffff)	#ffffff on #eff1f5	1.13:1 (need 4.5:1)	opentui TextTable default; message_block.tsx:69
catppuccin-latte	fgMuted on bg	#8c8fa1 on #eff1f5	2.83:1 (need 4.5:1)	labels/meta, placeholders (text_area.tsx:108)
catppuccin-latte	fgSubtle on bg	#9ca0b0 on #eff1f5	2.30:1 (need 4.5:1)	hints (welcome.tsx:37, run_block.tsx:75, message_block.tsx:52)
catppuccin-latte	accent on bg	#1e66f5 on #eff1f5	4.34:1 (need 4.5:1)	md headings/lists (design_system.ts:190), error_block.tsx:50
catppuccin-latte	info on bg	#04a5e5 on #eff1f5	2.47:1 (need 4.5:1)	md links (design_system.ts:191)
catppuccin-latte	user on bg	#04a5e5 on #eff1f5	2.47:1 (need 4.5:1)	message_block.tsx:50
catppuccin-latte	tool on bg	#04a5e5 on #eff1f5	2.47:1 (need 4.5:1)	tool_block.tsx:49, plan_card_block.tsx:52
catppuccin-latte	thinking on bg	#df8e1d on #eff1f5	2.31:1 (need 4.5:1)	thinking_block.tsx:31
catppuccin-latte	success on bg	#40a02b on #eff1f5	2.96:1 (need 4.5:1)	diff_block.tsx:27, run_block.tsx:59
catppuccin-latte	warning on bg	#df8e1d on #eff1f5	2.31:1 (need 4.5:1)	list_core.tsx:285, run marker
catppuccin-latte	border on bg	#bcc0cc on #eff1f5	1.61:1 (need 3:1)	panel frames (diff_block.tsx:29 …)
catppuccin-latte	syntax.string on bg	#40a02b on #eff1f5	2.96:1 (need 4.5:1)	design_system.ts syntax.string
catppuccin-latte	syntax.comment on bg	#7c7f93 on #eff1f5	3.49:1 (need 4.5:1)	design_system.ts syntax.comment
catppuccin-latte	syntax.number on bg	#fe640b on #eff1f5	2.64:1 (need 4.5:1)	design_system.ts syntax.number
catppuccin-latte	syntax.function on bg	#1e66f5 on #eff1f5	4.34:1 (need 4.5:1)	design_system.ts syntax.function
catppuccin-latte	syntax.type on bg	#df8e1d on #eff1f5	2.31:1 (need 4.5:1)	design_system.ts syntax.type
catppuccin-latte	syntax.operator on bg	#04a5e5 on #eff1f5	2.47:1 (need 4.5:1)	design_system.ts syntax.operator
catppuccin-latte	syntax.punctuation on bg	#7c7f93 on #eff1f5	3.49:1 (need 4.5:1)	design_system.ts syntax.punctuation
catppuccin-latte	fgMuted on bgRaised	#8c8fa1 on #e6e9ef	2.63:1 (need 4.5:1)	status_bar.tsx:39/46, dialog_panel.tsx:62, list_core.tsx:309
catppuccin-latte	accent on bgRaised	#1e66f5 on #e6e9ef	4.04:1 (need 4.5:1)	status_bar.tsx:35, dialog_panel.tsx:51
catppuccin-latte	warning on bgRaised	#df8e1d on #e6e9ef	2.15:1 (need 4.5:1)	which_key.tsx:51, status_bar.tsx:42
catppuccin-latte	success on bgRaised	#40a02b on #e6e9ef	2.75:1 (need 4.5:1)	status_bar.tsx:42 (tone), sidebar.tsx:217
catppuccin-latte	error on bgRaised	#d20f39 on #e6e9ef	4.46:1 (need 4.5:1)	status_bar.tsx:42 (tone), dialog_panel.tsx:51
catppuccin-latte	info on bgRaised	#04a5e5 on #e6e9ef	2.30:1 (need 4.5:1)	noticeColor info (app.tsx:451)
catppuccin-latte	fgMuted on bgActive	#8c8fa1 on #ccd0da	2.07:1 (need 4.5:1)	focused editor placeholder (text_area.tsx:108)
catppuccin-latte	fgSubtle on bgActive	#9ca0b0 on #ccd0da	1.69:1 (need 4.5:1)	chat_bar.tsx:79 (blurred bar), list_core.tsx:257
catppuccin-latte	accent on bgActive	#1e66f5 on #ccd0da	3.18:1 (need 4.5:1)	chat_bar.tsx:69, export_options_dialog.tsx:183
catppuccin-latte	secondary on bgActive	#8839ef on #ccd0da	3.51:1 (need 4.5:1)	list_core.tsx:259 (cursor row)
catppuccin-latte	success on bgActive	#40a02b on #ccd0da	2.17:1 (need 4.5:1)	list_core.tsx:257 (selected gutter)
catppuccin-latte	onAccent on accent	#eff1f5 on #1e66f5	4.34:1 (need 4.5:1)	confirm_dialog.tsx:87 (active button)
github-light	md table data cell (#ffffff)	#ffffff on #ffffff	1.00:1 (need 4.5:1)	opentui TextTable default; message_block.tsx:69
github-light	fgSubtle on bg	#8c959f on #ffffff	3.04:1 (need 4.5:1)	hints (welcome.tsx:37, run_block.tsx:75, message_block.tsx:52)
github-light	border on bg	#d0d7de on #ffffff	1.45:1 (need 3:1)	panel frames (diff_block.tsx:29 …)
github-light	fgSubtle on bgActive	#8c959f on #f0f3f6	2.73:1 (need 4.5:1)	chat_bar.tsx:79 (blurred bar), list_core.tsx:257
solarized-light	md table data cell (#ffffff)	#ffffff on #fdf6e3	1.08:1 (need 4.5:1)	opentui TextTable default; message_block.tsx:69
solarized-light	fg on bg	#657b83 on #fdf6e3	4.13:1 (need 4.5:1)	body text everywhere
solarized-light	fgMuted on bg	#93a1a1 on #fdf6e3	2.48:1 (need 4.5:1)	labels/meta, placeholders (text_area.tsx:108)
solarized-light	fgSubtle on bg	#b0b8b8 on #fdf6e3	1.87:1 (need 4.5:1)	hints (welcome.tsx:37, run_block.tsx:75, message_block.tsx:52)
solarized-light	accent on bg	#268bd2 on #fdf6e3	3.41:1 (need 4.5:1)	md headings/lists (design_system.ts:190), error_block.tsx:50
solarized-light	secondary on bg	#6c71c4 on #fdf6e3	4.06:1 (need 4.5:1)	inline code markup.raw (design_system.ts:211)
solarized-light	info on bg	#2aa198 on #fdf6e3	2.93:1 (need 4.5:1)	md links (design_system.ts:191)
solarized-light	user on bg	#2aa198 on #fdf6e3	2.93:1 (need 4.5:1)	message_block.tsx:50
solarized-light	assistant on bg	#6c71c4 on #fdf6e3	4.06:1 (need 4.5:1)	message_block.tsx:50
solarized-light	tool on bg	#2aa198 on #fdf6e3	2.93:1 (need 4.5:1)	tool_block.tsx:49, plan_card_block.tsx:52
solarized-light	thinking on bg	#b58900 on #fdf6e3	2.98:1 (need 4.5:1)	thinking_block.tsx:31
solarized-light	success on bg	#859900 on #fdf6e3	2.97:1 (need 4.5:1)	diff_block.tsx:27, run_block.tsx:59
solarized-light	warning on bg	#b58900 on #fdf6e3	2.98:1 (need 4.5:1)	list_core.tsx:285, run marker
solarized-light	error on bg	#dc322f on #fdf6e3	4.29:1 (need 4.5:1)	error_block.tsx:42, diff_block.tsx:27
solarized-light	border on bg	#93a1a1 on #fdf6e3	2.48:1 (need 3:1)	panel frames (diff_block.tsx:29 …)
solarized-light	syntax.keyword on bg	#859900 on #fdf6e3	2.97:1 (need 4.5:1)	design_system.ts syntax.keyword
solarized-light	syntax.string on bg	#2aa198 on #fdf6e3	2.93:1 (need 4.5:1)	design_system.ts syntax.string
solarized-light	syntax.comment on bg	#93a1a1 on #fdf6e3	2.48:1 (need 4.5:1)	design_system.ts syntax.comment
solarized-light	syntax.number on bg	#d33682 on #fdf6e3	4.21:1 (need 4.5:1)	design_system.ts syntax.number
solarized-light	syntax.function on bg	#268bd2 on #fdf6e3	3.41:1 (need 4.5:1)	design_system.ts syntax.function
solarized-light	syntax.type on bg	#b58900 on #fdf6e3	2.98:1 (need 4.5:1)	design_system.ts syntax.type
solarized-light	syntax.variable on bg	#657b83 on #fdf6e3	4.13:1 (need 4.5:1)	design_system.ts syntax.variable
solarized-light	syntax.operator on bg	#859900 on #fdf6e3	2.97:1 (need 4.5:1)	design_system.ts syntax.operator
solarized-light	syntax.punctuation on bg	#657b83 on #fdf6e3	4.13:1 (need 4.5:1)	design_system.ts syntax.punctuation
solarized-light	fg on bgRaised	#657b83 on #eee8d5	3.64:1 (need 4.5:1)	sidebar.tsx:168, results_dialog.tsx:64
solarized-light	fgMuted on bgRaised	#93a1a1 on #eee8d5	2.18:1 (need 4.5:1)	status_bar.tsx:39/46, dialog_panel.tsx:62, list_core.tsx:309
solarized-light	accent on bgRaised	#268bd2 on #eee8d5	3.00:1 (need 4.5:1)	status_bar.tsx:35, dialog_panel.tsx:51
solarized-light	warning on bgRaised	#b58900 on #eee8d5	2.62:1 (need 4.5:1)	which_key.tsx:51, status_bar.tsx:42
solarized-light	success on bgRaised	#859900 on #eee8d5	2.62:1 (need 4.5:1)	status_bar.tsx:42 (tone), sidebar.tsx:217
solarized-light	error on bgRaised	#dc322f on #eee8d5	3.77:1 (need 4.5:1)	status_bar.tsx:42 (tone), dialog_panel.tsx:51
solarized-light	info on bgRaised	#2aa198 on #eee8d5	2.58:1 (need 4.5:1)	noticeColor info (app.tsx:451)
solarized-light	fg on bgActive	#657b83 on #eee8d5	3.64:1 (need 4.5:1)	text_area.tsx:109-111, light-theme selection (app.tsx:242)
solarized-light	fgMuted on bgActive	#93a1a1 on #eee8d5	2.18:1 (need 4.5:1)	focused editor placeholder (text_area.tsx:108)
solarized-light	fgSubtle on bgActive	#b0b8b8 on #eee8d5	1.65:1 (need 4.5:1)	chat_bar.tsx:79 (blurred bar), list_core.tsx:257
solarized-light	accent on bgActive	#268bd2 on #eee8d5	3.00:1 (need 4.5:1)	chat_bar.tsx:69, export_options_dialog.tsx:183
solarized-light	secondary on bgActive	#6c71c4 on #eee8d5	3.57:1 (need 4.5:1)	list_core.tsx:259 (cursor row)
solarized-light	success on bgActive	#859900 on #eee8d5	2.62:1 (need 4.5:1)	list_core.tsx:257 (selected gutter)
solarized-light	onAccent on accent	#fdf6e3 on #268bd2	3.41:1 (need 4.5:1)	confirm_dialog.tsx:87 (active button)
solarized-light	onAccent on error	#fdf6e3 on #dc322f	4.29:1 (need 4.5:1)	chat.tsx:112-113 (error banner)
gruvbox-light	md table data cell (#ffffff)	#ffffff on #fbf1c7	1.13:1 (need 4.5:1)	opentui TextTable default; message_block.tsx:69
gruvbox-light	fgMuted on bg	#7c6f64 on #fbf1c7	4.29:1 (need 4.5:1)	labels/meta, placeholders (text_area.tsx:108)
gruvbox-light	fgSubtle on bg	#a89984 on #fbf1c7	2.45:1 (need 4.5:1)	hints (welcome.tsx:37, run_block.tsx:75, message_block.tsx:52)
gruvbox-light	accent on bg	#b57614 on #fbf1c7	3.33:1 (need 4.5:1)	md headings/lists (design_system.ts:190), error_block.tsx:50
gruvbox-light	success on bg	#79740e on #fbf1c7	4.29:1 (need 4.5:1)	diff_block.tsx:27, run_block.tsx:59
gruvbox-light	border on bg	#bdae93 on #fbf1c7	1.92:1 (need 3:1)	panel frames (diff_block.tsx:29 …)
gruvbox-light	syntax.string on bg	#79740e on #fbf1c7	4.29:1 (need 4.5:1)	design_system.ts syntax.string
gruvbox-light	syntax.comment on bg	#7c6f64 on #fbf1c7	4.29:1 (need 4.5:1)	design_system.ts syntax.comment
gruvbox-light	syntax.function on bg	#427b58 on #fbf1c7	4.40:1 (need 4.5:1)	design_system.ts syntax.function
gruvbox-light	syntax.type on bg	#b57614 on #fbf1c7	3.33:1 (need 4.5:1)	design_system.ts syntax.type
gruvbox-light	syntax.operator on bg	#427b58 on #fbf1c7	4.40:1 (need 4.5:1)	design_system.ts syntax.operator
gruvbox-light	syntax.punctuation on bg	#7c6f64 on #fbf1c7	4.29:1 (need 4.5:1)	design_system.ts syntax.punctuation
gruvbox-light	fgMuted on bgRaised	#7c6f64 on #ebdbb2	3.55:1 (need 4.5:1)	status_bar.tsx:39/46, dialog_panel.tsx:62, list_core.tsx:309
gruvbox-light	accent on bgRaised	#b57614 on #ebdbb2	2.75:1 (need 4.5:1)	status_bar.tsx:35, dialog_panel.tsx:51
gruvbox-light	warning on bgRaised	#af3a03 on #ebdbb2	4.46:1 (need 4.5:1)	which_key.tsx:51, status_bar.tsx:42
gruvbox-light	success on bgRaised	#79740e on #ebdbb2	3.55:1 (need 4.5:1)	status_bar.tsx:42 (tone), sidebar.tsx:217
gruvbox-light	fgMuted on bgActive	#7c6f64 on #d5c4a1	2.84:1 (need 4.5:1)	focused editor placeholder (text_area.tsx:108)
gruvbox-light	fgSubtle on bgActive	#a89984 on #d5c4a1	1.62:1 (need 4.5:1)	chat_bar.tsx:79 (blurred bar), list_core.tsx:257
gruvbox-light	accent on bgActive	#b57614 on #d5c4a1	2.20:1 (need 4.5:1)	chat_bar.tsx:69, export_options_dialog.tsx:183
gruvbox-light	secondary on bgActive	#076678 on #d5c4a1	3.85:1 (need 4.5:1)	list_core.tsx:259 (cursor row)
gruvbox-light	success on bgActive	#79740e on #d5c4a1	2.83:1 (need 4.5:1)	list_core.tsx:257 (selected gutter)
gruvbox-light	onAccent on accent	#fbf1c7 on #b57614	3.33:1 (need 4.5:1)	confirm_dialog.tsx:87 (active button)
one-light	md table data cell (#ffffff)	#ffffff on #fafafa	1.04:1 (need 4.5:1)	opentui TextTable default; message_block.tsx:69
one-light	fgMuted on bg	#a0a1a7 on #fafafa	2.47:1 (need 4.5:1)	labels/meta, placeholders (text_area.tsx:108)
one-light	fgSubtle on bg	#bcbcc2 on #fafafa	1.81:1 (need 4.5:1)	hints (welcome.tsx:37, run_block.tsx:75, message_block.tsx:52)
one-light	accent on bg	#4078f2 on #fafafa	3.88:1 (need 4.5:1)	md headings/lists (design_system.ts:190), error_block.tsx:50
one-light	info on bg	#0184bc on #fafafa	4.00:1 (need 4.5:1)	md links (design_system.ts:191)
one-light	user on bg	#0184bc on #fafafa	4.00:1 (need 4.5:1)	message_block.tsx:50
one-light	tool on bg	#0184bc on #fafafa	4.00:1 (need 4.5:1)	tool_block.tsx:49, plan_card_block.tsx:52
one-light	thinking on bg	#c18401 on #fafafa	3.06:1 (need 4.5:1)	thinking_block.tsx:31
one-light	success on bg	#50a14f on #fafafa	3.07:1 (need 4.5:1)	diff_block.tsx:27, run_block.tsx:59
one-light	warning on bg	#c18401 on #fafafa	3.06:1 (need 4.5:1)	list_core.tsx:285, run marker
one-light	error on bg	#e45649 on #fafafa	3.51:1 (need 4.5:1)	error_block.tsx:42, diff_block.tsx:27
one-light	border on bg	#d1d1d2 on #fafafa	1.46:1 (need 3:1)	panel frames (diff_block.tsx:29 …)
one-light	syntax.string on bg	#50a14f on #fafafa	3.07:1 (need 4.5:1)	design_system.ts syntax.string
one-light	syntax.comment on bg	#a0a1a7 on #fafafa	2.47:1 (need 4.5:1)	design_system.ts syntax.comment
one-light	syntax.function on bg	#4078f2 on #fafafa	3.88:1 (need 4.5:1)	design_system.ts syntax.function
one-light	syntax.type on bg	#c18401 on #fafafa	3.06:1 (need 4.5:1)	design_system.ts syntax.type
one-light	syntax.operator on bg	#0184bc on #fafafa	4.00:1 (need 4.5:1)	design_system.ts syntax.operator
one-light	fgMuted on bgRaised	#a0a1a7 on #f0f0f1	2.26:1 (need 4.5:1)	status_bar.tsx:39/46, dialog_panel.tsx:62, list_core.tsx:309
one-light	accent on bgRaised	#4078f2 on #f0f0f1	3.56:1 (need 4.5:1)	status_bar.tsx:35, dialog_panel.tsx:51
one-light	warning on bgRaised	#c18401 on #f0f0f1	2.81:1 (need 4.5:1)	which_key.tsx:51, status_bar.tsx:42
one-light	success on bgRaised	#50a14f on #f0f0f1	2.81:1 (need 4.5:1)	status_bar.tsx:42 (tone), sidebar.tsx:217
one-light	error on bgRaised	#e45649 on #f0f0f1	3.22:1 (need 4.5:1)	status_bar.tsx:42 (tone), dialog_panel.tsx:51
one-light	info on bgRaised	#0184bc on #f0f0f1	3.67:1 (need 4.5:1)	noticeColor info (app.tsx:451)
one-light	fgMuted on bgActive	#a0a1a7 on #eaeaeb	2.14:1 (need 4.5:1)	focused editor placeholder (text_area.tsx:108)
one-light	fgSubtle on bgActive	#bcbcc2 on #eaeaeb	1.57:1 (need 4.5:1)	chat_bar.tsx:79 (blurred bar), list_core.tsx:257
one-light	accent on bgActive	#4078f2 on #eaeaeb	3.37:1 (need 4.5:1)	chat_bar.tsx:69, export_options_dialog.tsx:183
one-light	success on bgActive	#50a14f on #eaeaeb	2.67:1 (need 4.5:1)	list_core.tsx:257 (selected gutter)
one-light	onAccent on accent	#fafafa on #4078f2	3.88:1 (need 4.5:1)	confirm_dialog.tsx:87 (active button)
one-light	onAccent on error	#fafafa on #e45649	3.51:1 (need 4.5:1)	chat.tsx:112-113 (error banner)

173 failing pairs of 400 checked
```

_Generated by the audit scripts (pixel sampler, pair matrix, fix suggester) in the session scratchpad; re-runnable against `design_system.ts` after any palette change._
