/**
 * The single source of truth for every non-ASCII glyph the TUI prints. Centralized so the same
 * character is reused everywhere (no `✓` vs `✔`, `…` vs `...`, `·` vs `•` drift across files) and
 * so the project's glyph vocabulary is auditable in one place.
 *
 * Every glyph lives in a Box-Drawing / Geometric-Shapes / Arrows / Dingbats range that virtually
 * all monospace terminal fonts render at a single cell width. Deliberately NO pictographic emoji
 * and NO Nerd-Font private-use glyphs: those render double-width or as tofu in many terminals and
 * would break the fixed-column gutter alignment the layout relies on.
 *
 * Names describe the SHAPE, not a use, because one glyph serves several semantic roles (the filled
 * `circle` is the `ready` status, the `run` gutter marker, AND the active-radio dot). Callers that
 * carry domain meaning map their role onto a shape here — see `layout/markers.ts` (gutter kinds)
 * and `app.tsx`'s `statusState` (chat state).
 */
export const GLYPHS = {
    /** U+2713 — success / present / completed (gutter `ok`, sidebar marker-written, status ready-adjacent). */
    check: "✓",
    /** U+2717 — failure / absent (gutter `error`, chat `error` status). */
    cross: "✗",
    /** U+26A0 — caution; a soft "needs attention" weaker than {@link GLYPHS.cross} (sidebar: no on-disk marker). */
    warning: "⚠",
    /** U+25CF — filled circle: a settled/active dot (chat `ready`, gutter `run`, active radio option). */
    circle: "●",
    /** U+25D0 — half-filled circle: in-progress / busy (chat `thinking` status). */
    circleHalf: "◐",
    /** U+25C6 — filled diamond: the `thinking` gutter marker. */
    diamond: "◆",
    /** U+25B8 — small right triangle: the `tool` gutter marker (and a collapsed/disclosed affordance). */
    triangleRight: "▸",
    /** U+270E — pencil: the `fileEdit` gutter marker. */
    pencil: "✎",
    /** U+203A — single right angle quote: the highlighted-row cursor in pickers. */
    chevronRight: "›",
    /** U+2191 — up. Paired with {@link GLYPHS.arrowDown} for vertical-move hints. */
    arrowUp: "↑",
    /** U+2193 — down. */
    arrowDown: "↓",
    /** U+2190 — left. Paired with {@link GLYPHS.arrowRight} for horizontal-change hints. */
    arrowLeft: "←",
    /** U+2192 — right. */
    arrowRight: "→",
    /** U+00B7 — middle dot: the inline separator between hint/metadata segments (` a · b · c `). */
    middot: "·",
    /** U+2026 — single-glyph ellipsis for placeholders and in-progress labels (never the three-dot `...`). */
    ellipsis: "…",
    /** U+2014 — em dash standing in for a value that is unavailable / not yet tracked. */
    emDash: "—",
} as const;
