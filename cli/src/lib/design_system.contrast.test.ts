import { describe, expect, test } from "bun:test";

import { themeIds, themes, type Theme, type ThemeColors, type ThemeSyntax } from "./design_system.ts";

/**
 * The rendered contrast matrix — the executable form of `docs/color_contrast_audit.md` and the
 * gate behind the theme-system spec's "WCAG AA contrast across the rendered pair matrix" requirement.
 *
 * Each {@link Surface} row is one (foreground token, background roles, threshold) tuple that some TUI
 * component ACTUALLY renders, tagged with that component (the `ref`). This test measures WCAG 2.1
 * relative-luminance contrast for every row × every background × every theme the row applies to (630
 * pairs) and fails, naming the theme/pair/ratio/threshold, if any pair drops below its floor: 4.5:1
 * for text, 3:1 for non-text UI (borders, focus frames) and the decorative `fgSubtle` tier.
 *
 * Four matrix conventions worth knowing before editing a row:
 *  - A bordered box paints its border glyphs on its OWN `backgroundColor`, not on whatever is behind
 *    it, so a frame around a raised panel renders on `bgRaised` and never on `bg`. Border rows
 *    therefore carry both surfaces.
 *  - `bgActive` reaches a token two different ways, and the difference decides which themes a row
 *    binds. Some tokens are drawn on a real `bgActive` surface (the focused editor, the list cursor
 *    row, the unfocused chat-bar footer) — those rows bind in every theme. The rest reach `bgActive`
 *    only through the selection highlight, which `applySelectionColors` (app.tsx) flattens to
 *    `bgActive` while preserving each token's foreground — but ONLY under a light theme. A dark theme
 *    falls through to opentui's native per-token inversion, which swaps foreground and background and
 *    so preserves the pair's ratio by construction. Selection-only rows are therefore `light`-only;
 *    binding them on dark themes would constrain a pair that never renders. See {@link SELECTION_SURFACES}.
 *  - `onAccent`'s backgrounds are the FILLED roles it is drawn on (`accent` for the confirm button,
 *    `error` for the error banner), not surface roles — so its row lists color roles that are
 *    themselves foreground tokens.
 *  - The diff bands are measured AS foregrounds against `bg`. Contrast is symmetric, so the row shape
 *    holds; what it encodes is that a band must be a perceptible tint rather than a repaint of `bg`.
 *
 * THE RULE (theme-system spec delta): a component that begins rendering a token on a background not
 * already in this matrix MUST add that (token, background) pair here in the same change. The matrix is
 * the single enforceable record of what renders where; a palette edit or new theme that breaks any
 * pair fails `bun test`, and a rendered pair missing from the matrix is a review-time violation.
 */

// WCAG 2.1 relative luminance + contrast ratio, inline (no dependency). Linearize each sRGB channel,
// weight by the luminance coefficients, then ratio = (Lhi + 0.05) / (Llo + 0.05).
function channel(v8: number): number {
    const c = v8 / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(hex: string): number {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * channel((n >> 16) & 0xff) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff);
}
function contrast(fg: string, bg: string): number {
    const a = luminance(fg);
    const b = luminance(bg);
    const [hi, lo] = a >= b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
}

const TEXT = 4.5;
const NON_TEXT = 3;
/**
 * Floor for a diff row band against `bg`. Not a WCAG number — WCAG says nothing about a decorative
 * fill whose meaning is carried redundantly by the `+`/`−` sign column. It is the weight of the
 * weakest band opentui itself ships (`#4d1a1a` on a typical dark chat background, 1.20:1), which is
 * the least tint that still reads as a band rather than as `bg`. A band also sits between `fg` and
 * `bg`, and those two ratios multiply exactly, so a theme can only host a band at this floor when
 * contrast(fg, bg) ≥ 4.5 × 1.2 — the constraint that sets `solarized-light`'s `fg`.
 */
const BAND = 1.2;

/** One rendered contrast constraint: a foreground token, the background roles it renders on, its floor, and the component(s) that render it. */
type Surface = {
    /** Human label used in the failure message (e.g. `"fg"`, `"syntax.keyword"`). */
    token: string;
    /** Resolves the foreground hex from a theme (a color role or a syntax scope's `fg`). */
    fg: (t: Theme) => string;
    /** The background COLOR roles this foreground is drawn on. */
    on: (keyof ThemeColors)[];
    /** 4.5:1 for text, 3:1 for non-text / decorative, 1.2:1 for a diff band. */
    threshold: number;
    /** Theme variants that render this pair. Absent = every variant. */
    variants?: Theme["variant"][];
    /** The component(s) that render this pair — keeps stale rows auditable. */
    ref: string;
};

// Color-role surfaces. Backgrounds are the immovable identity anchors (`bg`/`bgRaised`/`bgActive`) plus,
// for `fg`, the diff bands, and for `onAccent`, the filled `accent`/`error` it is drawn on.
const COLOR_SURFACES: Surface[] = [
    {
        token: "fg",
        fg: (t) => t.colors.fg,
        on: ["bg", "bgRaised", "bgActive", "diffAddedBg", "diffRemovedBg"],
        threshold: TEXT,
        ref: "body text everywhere; focused editor text (text_area.tsx); diff context/changed lines on the bands (diff_block.tsx)",
    },
    {
        token: "fgMuted",
        fg: (t) => t.colors.fgMuted,
        on: ["bg", "bgRaised", "bgActive"],
        threshold: TEXT,
        ref: "labels/meta/hints; status_bar.tsx, dialog_panel.tsx, text_area.tsx placeholder, list_core.tsx detail, diff lineNumberFg",
    },
    {
        token: "fgSubtle",
        fg: (t) => t.colors.fgSubtle,
        on: ["bg", "bgRaised", "bgActive"],
        threshold: NON_TEXT,
        ref: "DECORATIVE tier — empty meter cells (run_block.tsx), list gutter on a dialog panel and on the cursor row (list_core.tsx); 3:1 floor only",
    },
    {
        token: "accent",
        fg: (t) => t.colors.accent,
        on: ["bg", "bgRaised", "bgActive"],
        threshold: TEXT,
        ref: "md headings/lists, status bar title, dialog titles, NORMAL-mode label on the unfocused chat bar (chat_bar.tsx)",
    },
    {
        token: "secondary",
        fg: (t) => t.colors.secondary,
        on: ["bg", "bgActive"],
        threshold: TEXT,
        ref: "inline code (markup.raw), list cursor row (list_core.tsx)",
    },
    { token: "info", fg: (t) => t.colors.info, on: ["bg", "bgRaised"], threshold: TEXT, ref: "md links, notices (app.tsx noticeColor)" },
    { token: "user", fg: (t) => t.colors.user, on: ["bg"], threshold: TEXT, ref: "chat marker/label (message_block.tsx)" },
    { token: "assistant", fg: (t) => t.colors.assistant, on: ["bg"], threshold: TEXT, ref: "chat marker/label (message_block.tsx)" },
    { token: "thinking", fg: (t) => t.colors.thinking, on: ["bg"], threshold: TEXT, ref: "reasoning marker/label (thinking_block.tsx)" },
    { token: "tool", fg: (t) => t.colors.tool, on: ["bg"], threshold: TEXT, ref: "tool names (tool_block.tsx)" },
    {
        token: "success",
        fg: (t) => t.colors.success,
        on: ["bg", "bgRaised", "bgActive"],
        threshold: TEXT,
        ref: "diff counts/signs, run progress, tones, selected gutter (diff_block.tsx, run_block.tsx, list_core.tsx)",
    },
    { token: "warning", fg: (t) => t.colors.warning, on: ["bg", "bgRaised"], threshold: TEXT, ref: "which-key strokes, tones (which_key.tsx, status_bar.tsx)" },
    {
        token: "error",
        fg: (t) => t.colors.error,
        on: ["bg", "bgRaised"],
        threshold: TEXT,
        ref: "error text, tones, diff signs (error_block.tsx, diff_block.tsx)",
    },
    {
        token: "border",
        fg: (t) => t.colors.border,
        on: ["bg", "bgRaised"],
        threshold: NON_TEXT,
        ref: "panel frames on bg (diff_block.tsx) and on their own raised fill (tool_block.tsx, sidebar.tsx); md table/rule/quote chrome via the `conceal` scope",
    },
    {
        token: "borderFocus",
        fg: (t) => t.colors.borderFocus,
        on: ["bg", "bgRaised"],
        threshold: NON_TEXT,
        ref: "focus frames (text_area.tsx on bg); dialog panel frame on its own raised fill (dialog_panel.tsx)",
    },
    {
        token: "onAccent",
        fg: (t) => t.colors.onAccent,
        on: ["accent", "error"],
        threshold: TEXT,
        ref: "confirm button on accent (confirm_dialog.tsx), error banner on error (chat.tsx)",
    },
    {
        token: "diffAddedBg",
        fg: (t) => t.colors.diffAddedBg,
        on: ["bg"],
        threshold: BAND,
        ref: "added-row band must read as a tint, not as bg (diff_block.tsx)",
    },
    {
        token: "diffRemovedBg",
        fg: (t) => t.colors.diffRemovedBg,
        on: ["bg"],
        threshold: BAND,
        ref: "removed-row band must read as a tint, not as bg (diff_block.tsx)",
    },
];

// Code-block scopes. Every syntax token renders in the chat stream's fenced code (on `bg`) and in a
// tool result's `<code>` panel, which paints its own `bgRaised` fill (tool_block.tsx).
const SYNTAX_SCOPES: (keyof ThemeSyntax)[] = ["keyword", "string", "comment", "number", "function", "type", "variable", "operator", "punctuation"];
const SYNTAX_SURFACES: Surface[] = SYNTAX_SCOPES.map((scope) => ({
    token: `syntax.${scope}`,
    fg: (t) => t.syntax[scope].fg,
    on: ["bg", "bgRaised"],
    threshold: TEXT,
    ref: "code blocks in the chat stream (message_block.tsx via syntaxStyle) and tool results (tool_block.tsx)",
}));

// Selection-only pairs: these tokens never sit on a real `bgActive` surface. They reach `bgActive`
// solely because a light theme's selection flattens the background under them while keeping their
// foreground (`applySelectionColors` in app.tsx sets selectionBg=bgActive, selectionFg=undefined, and
// opentui forwards a null selection fg, leaving each token's own color). Dark themes take opentui's
// native per-token inversion instead, which swaps fg/bg and preserves the ratio — nothing new to check.
const SELECTION_TOKENS: (keyof ThemeColors)[] = ["info", "user", "assistant", "thinking", "tool", "warning", "error"];
const SELECTION_SURFACES: Surface[] = [
    ...SELECTION_TOKENS.map((role) => ({
        token: role,
        fg: (t: Theme): string => t.colors[role],
        on: ["bgActive"] as (keyof ThemeColors)[],
        threshold: TEXT,
        variants: ["light"] as Theme["variant"][],
        ref: "stream markers/labels/status under a light-theme selection highlight (app.tsx applySelectionColors)",
    })),
    ...SYNTAX_SCOPES.map((scope) => ({
        token: `syntax.${scope}`,
        fg: (t: Theme): string => t.syntax[scope].fg,
        on: ["bgActive"] as (keyof ThemeColors)[],
        threshold: TEXT,
        variants: ["light"] as Theme["variant"][],
        ref: "selected code in the chat stream under a light theme (app.tsx applySelectionColors)",
    })),
];

const SURFACES: Surface[] = [...COLOR_SURFACES, ...SYNTAX_SURFACES, ...SELECTION_SURFACES];

describe("WCAG AA contrast across the rendered pair matrix", () => {
    // One test per theme: it measures every surface that applies to that theme's variant × every
    // background, and fails with the full list of violations, each naming
    // theme · token (fg hex) on role (bg hex) = ratio, required threshold · ref.
    for (const id of themeIds) {
        test(`${themes[id].name} (${id}) meets AA on every rendered pair`, () => {
            const theme = themes[id];
            const failures: string[] = [];
            for (const s of SURFACES) {
                if (s.variants && !s.variants.includes(theme.variant)) continue;
                const fg = s.fg(theme);
                for (const role of s.on) {
                    const bg = theme.colors[role];
                    const r = contrast(fg, bg);
                    if (r < s.threshold) {
                        failures.push(`${id} · ${s.token} (${fg}) on ${role} (${bg}) = ${r.toFixed(2)}:1, need ${s.threshold}:1 · ${s.ref}`);
                    }
                }
            }
            expect(failures).toEqual([]);
        });
    }

    // Guards the matrix wiring itself: every accessor must resolve a real 6-digit hex and every
    // background role must exist, so a mistyped accessor fails loudly instead of silently skipping a pair.
    test("every surface accessor resolves a valid hex on every theme", () => {
        for (const id of themeIds) {
            const theme = themes[id];
            for (const s of SURFACES) {
                expect(s.fg(theme)).toMatch(/^#[0-9a-fA-F]{6}$/);
                for (const role of s.on) expect(theme.colors[role]).toMatch(/^#[0-9a-fA-F]{6}$/);
            }
        }
    });

    // A selection-only row that binds on every variant would constrain a pair no dark theme renders.
    // Pin the intent so a later edit cannot quietly widen those rows back to all themes.
    test("selection-only rows bind on light themes only", () => {
        for (const s of SELECTION_SURFACES) expect(s.variants).toEqual(["light"]);
    });
});
