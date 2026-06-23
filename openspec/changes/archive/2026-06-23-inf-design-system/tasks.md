## 1. Design tokens (foundation)

- [x] 1.1 Create `src/tui/tokens.ts` with `space` {none:0, sm:1, md:2, lg:4}, `size` {gutter:2, statusBar:1, railWidth:40, composerMin:1, paletteRows:12}, `stroke` {panel:"single", overlay:"rounded", focus:"heavy", danger:"double"}, each `as const`; export `Space`/`Stroke` union types. JSDoc each.
- [x] 1.2 Refactor inline layout integers to tokens: `sidebar.tsx` width (40→`size.railWidth`), section paddings, `input_bar.tsx` min/max height, `status_bar.tsx` height (→`size.statusBar`), gutter/padding in `message_block.tsx` and `chat.tsx`.
- [x] 1.3 Refactor `borderStyle` literals to `stroke.*` where present in `src/tui/`.

## 2. Color-role realignment (foundation)

- [x] 2.1 Rewrite `ThemeColors` in `src/lib/themes.ts` to the new vocabulary: `bg, bgRaised, bgActive, fg, fgMuted, fgSubtle, border, borderFocus, onAccent, accent, secondary, success, warning, error, info, user, assistant, tool, thinking` (JSDoc the type).
- [x] 2.2 Update all 10 theme palettes: rename existing hex to new keys (`bgPanel→bgRaised`, `bgFocused→bgActive`, `muted→fgMuted`, `borderActive→borderFocus`, `warn→warning`, drop `selected`), and choose per-theme values for new roles `fgSubtle`, `onAccent`, `tool`, `thinking` (tokyo-night: `fgSubtle`=#3b4261, `tool`=#7dcfff, `thinking`=#e0af68, `onAccent`=#1a1b26).
- [x] 2.3 Update `src/tui/theme.ts`: `noticeColor` (`warn`→`warning`), any token references, and JSDoc mentioning token names.
- [x] 2.4 Repoint every `theme().<role>` call site across `src/tui/` to the new names (incl. `selected`→`bgActive` in pickers/`select_list.tsx`); rely on `tsc` to surface every missed site.
- [x] 2.5 Update `markers.ts` role mappings to use the new domain roles where applicable (`tool` marker → `tool` role, `thinking` → `thinking` role).

## 3. Mock data models + fixtures

- [x] 3.1 Extend the `Part` union in `src/types/session.ts` to a discriminated union: add mock `ThinkingPart` (reasoning + optional duration), `ToolCallPart` (tool name, target, result, status), `FileEditPart` (path, hunk lines, +/− counts). JSDoc each type and property; distinct `type` literals.
- [x] 3.2 Define mock `Run`/`Step` model types (run id/name/status/progress, step state done/running/queued) and a token-cost/context model (tokens, percent, cost), with JSDoc. In-memory only — no DB/migration/query.
- [x] 3.3 Create a clearly-named mock fixtures module (e.g. `src/tui/layout/mock_fixtures.ts`) with sample data for each part kind, a sample run with steps, and a sample context, each commented as sample/mock data.

## 4. Stream blocks

- [x] 4.1 Make `MessageBlock` switch on `part.type` for all kinds with a `never`-typed default branch; delegate each kind to its block renderer.
- [x] 4.2 Thinking block — `◆` marker, duration, collapsed-by-default italic reasoning body with an expand affordance.
- [x] 4.3 Tool-call block — `▸` marker, tool/verb + target, result via `<code>`, completion line.
- [x] 4.4 Diff/file-edit block — `✎` marker, file + counts, hunk via `<diff>`, accept/reject/edit affordances.
- [x] 4.5 Run/task block — `●` marker, run name, progress bar, indented step list (done/running/queued), detach/abort hints; fed by the mock run fixture.
- [x] 4.6 Welcome/startup block — `<ascii_font>` wordmark + greeting, anchor path with ✓/⚠ badge, resume/command hints; rendered in the empty-stream state in `chat.tsx`; reads workspace/anchor data, writes nothing to disk.
- [x] 4.7 Error/abort block — richer styled error surface using `stroke.danger` chrome and `onAccent` foreground; degraded-anchor (`markerWritten=false`) callout from existing anchor state.

## 5. Sidebar + on-color application

- [x] 5.1 Sidebar CONTEXT slot renders token/percent/cost from the mock context fixture (replacing the em-dash placeholder).
- [x] 5.2 Sidebar RUNS slot renders live/completed run rows from the mock run fixture (replacing "no runs yet").
- [x] 5.3 Apply `onAccent` to the `chat.tsx` error banner (replace `fg={theme().bg}`) and any other filled-background foreground (status bar fills, reverse/selection rows).

## 6. Verification

- [x] 6.1 `bun run typecheck` clean (the rename + exhaustive switch are type-enforced — zero errors).
- [x] 6.2 `bun run lint` clean; no inlined hex in `src/tui/`, no inline glyph literals, no `.forEach`.
- [x] 6.3 Launch the TUI and visually confirm each of the 8 block states renders faithfully (use the mock fixtures); verify `<code>`/`<diff>`/`<ascii_font>` renderables behave — if a needed prop is missing, fall back to a `<text>`/`<box>` composition rather than adding a dependency.
- [x] 6.4 Confirm no file/disk writes occur on passive render (welcome/sidebar) — the no-litter rule.
- [x] 6.5 `bun run format:file` on every changed file under `src/`.

## 7. Type & emphasis vocabulary

- [x] 7.1 Create `src/tui/components/emphasis.tsx` with six inline JSX components — `<Bold>`, `<Italic>`, `<Underline>` (wrapping opentui's `<b>`/`<i>`/`<u>`) and `<Dim>`, `<Fg role={…}>` (wrapping `<span style={{ dim/fg }}>`) plus `<Reverse>` as an explicit `<span style={{ fg: theme().bg, bg: theme().fg }}>` swap. It is the ONLY module touching opentui's `t`/`fg`/`bold`/… primitives or a span `style` prop; document the `style` channel + the file-level `solid/style-prop` disable. `<Reverse>` is an explicit fg/bg swap — the `inverse` attribute collapses to an invisible block — and never the dead `reverse()` helper.
- [x] 7.2 Repoint every styled-text call site to the components: thinking / tool / diff / run / error blocks, sidebar (RUNS + Section label), design gallery, message_block (You/Assistant), status_bar (identity), which_key (group label), select_list (group header). No `src/tui/` file outside `emphasis.tsx` imports `t`/`fg`/`bold`/`dim`/`italic`/`underline`/`reverse`/`bg` from `@opentui/core`.
- [x] 7.3 No call-site `<span style={{ fg }}>` remains; the only `solid/style-prop` disable is the documented file-level one in `emphasis.tsx`, and `bun run lint` is clean.
- [x] 7.4 Replace every magic `attributes={1}` (bold) / `attributes={4}` (italic) literal in `src/tui/` with `<Bold>`/`<Italic>`; a single whole-line color stays as `<text fg={theme().role}>`.
- [x] 7.5 Add a "Type & emphasis" panel to the design gallery showing bold/regular/dim/italic/underline/reverse (via the components) with their semantic labels.
- [x] 7.6 Document the text-emphasis vocabulary (component table + composing/when-to-use) in CLAUDE.md (beside the glyph/theme rules).
- [x] 7.7 Route selection / cursor highlighting through `<Reverse>`: the focused inflexa-config section header renders inverse (`<Reverse><Bold>…</Bold></Reverse>`).
- [x] 7.8 Verify: `bun run typecheck` + `bun run lint` clean, `bun test` green, and a headless `captureSpans` render confirms the attribute bits land (Bold→1, Italic→4, Underline→8, Dim→2, Reverse→32, Fg→colored); `bun run format`.
