## Context

The chat TUI already ships the Direction-B shell (status bar + scrollbox stream + toggleable sidebar + composer), a reactive 10-theme registry, a centralized glyph set, and a keymap engine. The "inf Design System" doc formalizes the language around that shell. Three foundations are absent or inconsistent:

1. **Color roles** — `ThemeColors` has 2 foreground tiers (`fg`, `muted`) where every major system has 3, and no "on-color" role (the error banner fakes it by painting `fg={theme().bg}` over a filled background in `chat.tsx`).
2. **Layout tokens** — no `tokens.ts`; spacing/dimensions are inline integers (`SIDEBAR_WIDTH = 40`, `minHeight={3}`, paddings).
3. **Stream blocks** — only 2 of 8 canonical states exist (plain chat, command palette). The other 6 need data the engine never produces: `src/types/session.ts` defines `Part = TextPart` and `chat.ts` emits only text.

The user's directive: build the **entire** system now, **mocking** any data model that doesn't exist yet (real type shapes + sample fixtures), without wiring the live engine to emit them.

## Goals / Non-Goals

**Goals:**
- A standards-grounded semantic color-role vocabulary applied uniformly across all 10 themes and every `theme()` call site.
- A `src/tui/tokens.ts` layer that removes raw layout integers from components.
- Faithful rendering of all 8 stream-block states, driven by clearly-marked mock data.
- Replace the on-color hack with a real `onAccent` role.

**Non-Goals:**
- Wiring the live chat engine / agent backend to emit thinking, tool-call, file-edit parts, runs, or token-cost telemetry. The blocks are fed by fixtures; live emission is a follow-up change.
- Persistence or migrations — mock data is in-memory only (honors the no-litter rule: rendering writes nothing to disk).
- Keybinding changes — the doc's `^S`/`^R`/`^◄►` table is aspirational; the existing keymap engine is richer and stays.
- New dependencies.

## Decisions

### D1: Color-role vocabulary — Primer/Carbon-style functional set, not the doc's names

Researched against Material 3 (Compose `ColorScheme`), MUI (`createPalette`), GitHub Primer, IBM Carbon, Catppuccin, and Radix. Every system converges on: **3 foreground tiers** (default·muted·subtle), **2 border tiers** (subtle·strong/focus), an explicit **on-color** role for text on fills, and **4 status roles** (success·warning·error·info). The final `ThemeColors`:

```
surfaces:    bg, bgRaised, bgActive
foreground:  fg, fgMuted, fgSubtle
borders:     border, borderFocus
on-color:    onAccent
accent:      accent, secondary
status:      success, warning, error, info
domain:      user, assistant, tool, thinking
```

Renames from current: `bgPanel→bgRaised`, `bgFocused→bgActive`, `muted→fgMuted`, `borderActive→borderFocus`, `warn→warning`; `selected` folded into `bgActive`. New: `fgSubtle`, `onAccent`, `tool`, `thinking`.

- **Why not the design doc's names** (`surface/raised/fgFaint/id/ok/danger/tool`)? `ok`/`danger`/`id` are non-standard — MUI and Carbon both use `success`/`error`; `id` is a domain concept, not a color role. The doc's swatches are explicitly "an example dark theme — substitute yours."
- **Why keep the `bg*/fg*/border*` prefix grouping** over a full `surface*/text*` rename (Catppuccin/Carbon style)? Smallest churn from the current names while still standards-aligned (Primer groups by `bgColor`/`fgColor`/`borderColor`). User chose this fork.
- **Why fold `selected` into `bgActive`?** Radix step 5 ("Active / Selected UI element background") and most systems treat hover/active/selected as one elevated-background concern; a separate `selected` token was redundant.
- **Hex values**: each new role gets a value in all 10 themes. Renames keep their current hex. `fgSubtle`/`onAccent`/`tool`/`thinking` are chosen per theme (e.g. tokyo-night `fgSubtle`=#3b4261 per the doc's `fgFaint`, `tool`=#7dcfff, `thinking`=#e0af68, `onAccent`=the theme's `bg`).

### D2: Tokens as `as const` literals in `src/tui/tokens.ts`

`space` {none:0, sm:1, md:2, lg:4}, `size` {gutter:2, statusBar:1, railWidth:40, composerMin:1, paletteRows:12}, `stroke` {panel:"single", overlay:"rounded", focus:"heavy", danger:"double"}, each `as const` with derived `keyof typeof` union types.

- **Why `railWidth: 40`, not the doc's 30?** 40 is the current tuned `SIDEBAR_WIDTH`; the doc's 30 is an example. User chose to keep 40.
- **Why a new file** (vs. folding into `theme.ts`)? Tokens are layout primitives, dependency-light and solid-js-free, consumed by every layout component — same separation rationale as `lib/themes.ts` vs `tui/theme.ts`. It is multi-caller, so a new file is justified under the project's coding rules.
- `stroke` maps role → opentui `borderStyle`; `danger:"double"` is reserved for destructive-confirm chrome.

### D3: Mock data models live beside their consumers, fixtures clearly marked

- **Part union** grows in `src/types/session.ts`: `Part = TextPart | ThinkingPart | ToolCallPart | FileEditPart`, a discriminated union on `type`. New kinds carry only the fields their block renders. `MessageBlock` switches on `part.type` with a `never`-typed default branch (per CLAUDE.md), so a forgotten kind fails the build.
- **Run/Step** and **token-cost** are new mock model types with sample fixtures (a `mock`-namespaced fixtures module). These are NOT persisted and NOT queried from SQLite — they are in-memory sample data, named/commented so no reader mistakes them for live telemetry.
- **Why mock rather than defer?** User wants every state visible now. Mock fixtures let the blocks and the rail's CONTEXT/RUNS slots render real-looking data without inventing a live pipeline. The seam is the data source: swapping fixtures for engine events later touches only the data layer, not the blocks.
- **Tension with the existing "never fabricate" sidebar requirement**: today the sidebar shows `—` because no model exists. This change supplies an explicit mock model, so the values are *sample data from a named mock source*, not *fabricated* values presented as live. The modified requirement makes that distinction normative (mock data must be identifiable as mock).

### D4: Block widgets in `src/tui/components/`, one renderable each

The stream-block renderers are reusable presentational **widgets**, not shell composition — `src/tui/layout/` is reserved for the shell frame (status bar, sidebar, input bar, and the `MessageBlock` mapper). So each block is its own file under `src/tui/components/` (`thinking_block`, `tool_block`, `diff_block`, `run_block`, `error_block`, `welcome`), taking **primitive props** so it imports no domain types — satisfying the `components/` membership rule. Each maps to a built-in renderable: thinking → `<text>` italic body; tool-call → `<code>`; diff → `<diff>`; run → `<box>` progress + step list; welcome → `<ascii_font>` wordmark + `<text>`; error → bordered `<box>`. The domain `Part` → primitive-props mapping lives in `MessageBlock` (which stays in `layout/`, the one domain-coupled bridge). All use markers, colors via `theme()`, glyphs via `GLYPHS`, spacing/stroke via tokens. No custom drawing.

Because `components/` must not import `layout/`, the gutter marker vocabulary `markers.ts` moves up from `src/tui/layout/` to `src/tui/markers.ts` — design-system data at the tui root (a peer of `theme.ts`/`tokens.ts`), importable by both the shell (`MessageBlock`) and the widgets. The eight states are viewed via a `DesignGallery` (a `view.design-gallery` command) that renders every block from the mock fixtures, bypassing the live conversation store entirely.

### D5: Text emphasis via inline JSX components in `src/tui/components/emphasis.tsx`

The design's "Type & emphasis" scale (bold=names · regular=body · dim=meta · italic=reasoning · underline=paths · reverse=selection) is exposed as six composable inline JSX components — `<Bold>`, `<Italic>`, `<Underline>`, `<Dim>`, `<Reverse>`, `<Fg role={…}>` — each wrapping a single opentui inline span. Call sites use the components; only `emphasis.tsx` touches opentui's low-level styled-text primitives or the span `style` prop.

- **Why components, not direct `t`/helper calls at call sites?** Hand-composing `t``…${fg(theme().tool)(bold(s))}…``` is verbose, easy to get wrong, and leaked the broken `reverse()` helper into app code. Components read far better — `<Fg role="tool"><Bold>{s}</Bold></Fg>` — and confine the one unavoidable escape hatch (the span `style` prop) to a single documented file. (An earlier revision imported `@opentui/core` helpers directly at every call site; the user asked for JSX components, which is what shipped.)
- **The earlier "a component-only approach can't express the full scale" claim was wrong.** opentui-solid ships only `<b>`/`<i>`/`<u>` built-ins, but a CUSTOM component returning `<span style={{ dim: true }}>` / `{{ fg }}` / `{{ fg, bg }}` covers dim, color, and reverse too: the `@opentui/solid` reconciler's `setProperty` applies `node.attributes |= createTextAttributes(style)` and `node.fg/bg` for a span's `style`. Verified by headless `captureSpans`: Bold→1, Italic→4, Underline→8, Dim→2, Fg→colored, Reverse→dark fg on light bg.
- **`<Reverse>` is an EXPLICIT fg/bg swap, not the `inverse` attribute.** `style={{ inverse: true }}` does set the bit, but opentui bakes the inverse swap into the cell at render and — with the span's `bg` unset — collapses fg and bg to the same color: a solid, invisible block (observed in the config screen, `captureSpans` showing `fg === bg`). So `<Reverse>` paints both colors itself — `style={{ fg: theme().bg, bg: theme().fg }}` — the same swap the gallery used before componentization, and the only reliably-visible inverse. (This is also why `@opentui/core`'s `reverse()`, which only ever flips a bit, can't be used.) Selection / cursor highlighting (the focused config section) routes through `<Reverse>`.
- **`italic`/`dim` stay terminal-dependent** (tmux / Terminal.app often drop them), so those components are always paired with a muted `<Fg>` at call sites so meaning survives when the attribute is dropped.
- **The `style={{…}}` span channel trips `solid/style-prop`** (a CSS-oriented rule); a single file-level eslint-disable in `emphasis.tsx` documents why it is a false positive there. No call site uses `style`, so the rest of the tree stays clean — and `src/tui/text.ts` (a forwarding re-export) was removed, since the components, not a barrel, are the abstraction.
- **Trade-off accepted:** a single whole-line color stays as `<text fg={theme().role}>` (don't wrap one line in `<Fg>`); the components earn their place for mixed inline styling and semantic emphasis (names, selection). The magic `attributes={1}`/`{4}` literals across the TUI are replaced by `<Bold>`/`<Italic>`.

## Risks / Trade-offs

- **Wide mechanical rename across 10 themes + many call sites** → Mitigation: the rename is type-enforced; `tsc --noEmit` fails on any missed or misspelled token, so the compiler is the checklist. `noticeColor` and any `warn`→`warning` string references are caught the same way.
- **Mock data mistaken for live data by a future reader** → Mitigation: D3 — fixtures live in a `mock`-named module with comments, and the modified sidebar requirement mandates mock data be identifiable as such; never wired into the real `conversation`/event-bus path.
- **`<code>`/`<diff>`/`<ascii_font>` renderables may need props we haven't used yet** → Mitigation: they are built-in opentui renderables per the design's renderable map; if a prop is missing, fall back to a `<text>`-composed equivalent rather than adding a dependency. Flag in tasks as a verification step.
- **Scope breadth** (8 blocks + tokens + 10-theme recolor in one change) → Mitigation: ordered tasks — foundation (tokens, roles) first, then blocks layered on, each reusing the same marker/panel rules so there is no layout fork.
- **Folding `selected` into `bgActive`** changes any call site reading `theme().selected` → Mitigation: those sites (pickers/select list) repoint to `bgActive`; type-checked.
