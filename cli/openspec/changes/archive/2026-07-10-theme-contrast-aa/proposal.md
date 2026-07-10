## Why

The contrast audit ([`docs/color_contrast_audit.md`](../../../docs/color_contrast_audit.md)) found that tool results, markdown-table data rows, and diff lines render in opentui's built-in `#FFFFFF` default instead of a theme token — fully invisible (1.00–1.13:1) on every light theme — and that 173 of the 400 (token, background) pairs the TUI actually renders fail WCAG 2.1 AA in at least one built-in theme (`fgSubtle` and `border` fail in all ten). The product must be readable in both palette modes, and the guarantee must be enforceable, not re-audited by hand.

## What Changes

- Register a `"default"` syntax scope (→ `fg`) in the theme `SyntaxStyle` so un-captured spans — markdown pipe-table data cells, plain tool output, unhighlighted code — can never fall through to opentui's hardcoded `#FFFFFF`.
- Pass themed props at the three opentui call sites that currently rely on opentui defaults: `tool_block.tsx`'s `<code>` (`fg`), `diff_block.tsx`'s `<diff>` (`fg`, `syntaxStyle`, band/sign/line-number colors).
- Add a diff token group to `ThemeColors` (`diffAddedBg`, `diffRemovedBg`; signs and line numbers map to existing `success`/`error`/`fgMuted`) — the only vocabulary extension; no existing role can express a diff row band.
- Demote `fgSubtle` to decorative-only (floor ≥3:1): information-bearing call sites (keybind hints, durations, ids, message meta) move to `fgMuted`. Keeps the three-tier hierarchy meaningful instead of collapsing `fgSubtle` into a second `fgMuted` by retuning it to 4.5:1.
- Retune all ten built-in palettes so every rendered (token, background) pair meets AA — 4.5:1 text, 3:1 non-text — via hue-locked lightness adjustments (OKLCH) that preserve each theme's identity. **BREAKING** (visual): palette values change in every theme, including the default `tokyo-night` (its `fgMuted`/`fgSubtle`/`border`/`syntax.comment`); `solarized-light` and `catppuccin-latte` deviate furthest from their canonical upstreams — accepted trade-off.
- Land the audit's pair matrix as a checked-in contrast test (`design_system.contrast.test.ts`): enumerates every rendered pair × all themes and fails on any AA violation, making the policy permanent instead of a one-off audit.

## Capabilities

### New Capabilities

_None — contrast is a property of the existing theme system, not a new capability._

### Modified Capabilities

- `theme-system`: adds an AA contrast requirement over the rendered pair matrix (test-enforced); amends the token vocabulary (`fgSubtle` becomes decorative-only, diff token group added); amends "Themed markdown and code blocks" to require the registered `"default"` scope; amends the curated-palettes requirement (values retuned to AA, "byte-for-byte unchanged default look" no longer holds).
- `tui-stream-blocks`: block renderers must pass themed colors to every opentui renderable they embed (`<code>`, `<diff>`, markdown tables via the syntax style) — relying on an opentui built-in default color becomes a spec violation.

## Impact

- `src/lib/design_system.ts` — `markdownStyles()` gains the `default` scope; `ThemeColors` gains the diff group; all ten palettes retuned; `fgSubtle` doc contract narrowed.
- `src/tui/theme.ts` — no structural change (the `SyntaxStyle` cache picks up the new scope).
- `src/tui/components/tool_block.tsx`, `diff_block.tsx` — themed props at the opentui boundary.
- `fgSubtle` → `fgMuted` call-site swaps: `message_block.tsx`, `run_block.tsx`, `run_card_block.tsx`, `plan_card_block.tsx`, `thinking_block.tsx`, `tool_block.tsx`, `chat_bar.tsx`, `welcome.tsx`, `boot_indicator.tsx`, `diff_block.tsx` (audit lists exact lines).
- New test `src/lib/design_system.contrast.test.ts`; existing `theme.test.ts` extended (every theme registers `default`).
- Design gallery unchanged structurally — used for the visual identity check in a dark + a light theme.
- No dependency changes; no config/schema changes; no runtime API changes.
