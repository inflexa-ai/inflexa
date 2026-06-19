## Context

`src/tui/` is currently flat. CLAUDE.md says to keep it flat "while the surface is small … add `tui/<domain>/` (or module-side view folders) when a screen outgrows one file **or shared widgets emerge**," and mirrors Lumen's `components/` convention for shared widgets.

Three widgets are now genuinely shared and domain-agnostic (they import only `theme` + opentui/solid):

- `SelectList` (+ `SelectItem` + a private fuzzy scorer) in `select_list.tsx` — 2 importer files, 4 mount sites.
- `PromptDialog` and `ResultsDialog`, currently inside `command_palette.tsx` alongside the palette-specific `runCommand` + `CommandPalette`, which makes that file a grab-bag.

All three render the same dialog chrome: a bordered `bgPanel` box, an accent-colored title, `paddingLeft/Right=1`, and a trailing muted footer-hint line — duplicated three times with only the footer text (and panel size) varying.

Separately, the `Notice` presentation type (`{ kind: "info" | "warn" | "error"; text: string }`) is defined twice — exported from `commands.tsx` and redefined locally in `config.tsx` — and its kind→color mapping is inlined in `app.tsx` and duplicated as `noticeColor` in `config.tsx`.

## Goals / Non-Goals

**Goals:**

- A `src/tui/components/` directory with an explicit, enforceable membership rule.
- Relocate the three generic dialog widgets there, one file each, with no behavior change.
- A `DialogPanel` shell that owns the shared chrome so each widget supplies only its body + footer text.
- Reduce `command_palette.tsx` to palette-only.
- One shared `Notice` type and one `noticeColor` helper; remove the duplicates.
- Update CLAUDE.md's `src/tui/` inventory note.

**Non-Goals:**

- No behavior, layout, or keybinding changes — this is a pure refactor (chrome must look identical).
- No new dependencies.
- No change to the dialog-host, keyboard-gating, or fuzzy-ranking logic (only their *location*).
- NOT extracting a `NoticeBanner` component — the two screens render notices with deliberately different layouts (see Decisions).
- No changes under `src/modules/`, `src/db/`, or the event bus.

## Decisions

### 1. `components/` lives at `src/tui/components/`; membership rule is explicit

Mirrors the Lumen `components/` convention CLAUDE.md already cites. A widget belongs in `components/` **iff** it: (a) imports only `theme` + opentui/solid (no domain/module imports), and (b) has ≥2 callers. The palette-specific `CommandPalette` adapter fails (a) — it maps `Command` domain objects — so it stays in `tui/` as app-shell, not in `components/`.

*Alternative considered:* `src/components/` at the repo root. Rejected — these are terminal/Solid widgets coupled to `tui/theme.ts`; they are presentation-layer, not cross-cutting infra.

### 2. `DialogPanel` is pure chrome — not a keyboard/focus owner

`DialogPanel` renders only the outer frame and the optional footer line; the body is `children`. Each widget keeps its own `useKeyboard` and focus-on-mount, because the three differ fundamentally (list navigation vs. input submit vs. scroll), and the dialog-host keyboard-gating in `app.tsx` is unchanged.

Proposed API:

```tsx
function DialogPanel(props: {
    title: string;                    // accent-colored panel title
    width: string | number;           // "70%" (lists) | "60%" (prompt)
    height?: string | number;         // "60%" for the tall lists; omitted = auto (prompt)
    padY?: boolean;                   // top+bottom padding of 1 (the prompt's breathing room)
    footer?: string;                  // muted hint line, e.g. "↑/↓ move · Enter select · Esc cancel"
    children: JSX.Element;
}): JSX.Element
```

It always applies `backgroundColor={theme().bgPanel}`, `border`, `borderColor={theme().borderActive}`, `titleColor={theme().accent}`, `flexDirection="column"`, `paddingLeft/Right=1`, and renders `<text fg={theme().muted}>{props.footer}</text>` as the last child when `footer` is set. These props are exactly the union of the three current panels' chrome, so each reproduces verbatim:

| Widget | width | height | padY | footer |
|---|---|---|---|---|
| `SelectList` | 70% | 60% | — | `↑/↓ move · Enter select · Esc cancel` |
| `ResultsDialog` | 70% | 60% | — | `↑/↓ scroll · Esc/q close` |
| `PromptDialog` | 60% | (auto) | yes | `Enter submit · Esc cancel` |

`SelectList`'s highlighted-row description line stays inside its `children` (it sits above the footer), so `DialogPanel` needs no description prop.

*Alternative considered:* a heavier `Dialog` that also owns Esc/focus and a standard footer. Rejected — it would have to special-case three different key maps and focus targets, trading duplicated chrome for branching logic.

### 3. `Notice` type + `noticeColor` live in `src/tui/theme.ts`, not `components/` and not `src/types/`

`noticeColor(kind)` is fundamentally a **theme accessor**: a notice kind maps onto the palette's matching semantic role — in fact `noticeColor(kind) ≡ theme()[kind]`, since `Notice["kind"]` (`"info" | "warn" | "error"`) is exactly a subset of `ThemeColors`' keys. So it belongs with the other theme accessors in `theme.ts`, and the small `Notice` type rides along beside it (it is neither a Solid component, so not `components/`, nor a persisted entity / event-contract type, so not `src/types/`). `commands.tsx` (the `CommandContext.notify` signature), `app.tsx`, and `config.tsx` import both from `src/tui/theme.ts` directly. (An earlier draft homed these in a dedicated `src/tui/notice.ts`; folding them into `theme.ts` avoids a near-empty file and keeps the color logic next to the palette it reads.)

`noticeColor(kind: Notice["kind"]): string` reads `theme()` reactively and returns a color string; it is layout-agnostic — `app.tsx` uses it as a banner `backgroundColor` (inverted bar, `fg={theme().bg}`), `config.tsx` as the text `fg`. That difference is exactly why no shared `NoticeBanner` component is extracted: a single-caller component whose two would-be callers render differently is the wrong abstraction (and violates the "don't extract single-caller components" rule).

## Risks / Trade-offs

- **`DialogPanel` can't reproduce a widget's exact chrome** → the `width`/`height`/`padY`/`footer` prop set is the precise union of the three current panels; verify all three render identically after the move.
- **Reactivity lost when composing** → never destructure `props` in `DialogPanel`; read `theme()` inside JSX; pass `children` straight through. (Solid components run once.)
- **A missed importer / accidental shim** → grep every old import path (`./select_list`, `PromptDialog`/`ResultsDialog` from `command_palette`, `Notice` from `commands`/`config`), repoint each, add no shims, and let `bun run typecheck` confirm none dangle.
- **Footer string drift** → the three footer hints move verbatim into the new call sites; copy them exactly so no keybinding hint text changes.

## Migration Plan

1. Create `src/tui/components/dialog_panel.tsx` (`DialogPanel`).
2. Move `select_list.tsx` → `components/select_list.tsx`; move `PromptDialog`/`ResultsDialog` out of `command_palette.tsx` into `components/prompt_dialog.tsx` / `components/results_dialog.tsx`. Refactor all three to compose `DialogPanel`.
3. Add `Notice` + `noticeColor` to `src/tui/theme.ts`; delete the duplicate definitions in `commands.tsx` and `config.tsx`; inline the `app.tsx` color expression into `noticeColor`.
4. Repoint every importer (`commands.tsx`, `command_palette.tsx`, `app.tsx`, `config.tsx`); no shims.
5. Update the CLAUDE.md `src/tui/` inventory note.
6. `bun run typecheck` + `bun run lint` + `bun run format:file` on the changed `src/` files; verify the TUI renders the palette, a picker, a prompt, a results dialog, and a notice unchanged.

Rollback: revert the change set — no data, migrations, or external state involved.
