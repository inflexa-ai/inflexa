import { describe, expect, test } from "bun:test";

import { themeIds, themes, type Theme, type ThemeColors, type ThemeSyntax } from "./design_system.ts";

/**
 * The rendered contrast matrix — the executable form of `docs/color_contrast_audit.md` and the
 * gate behind the theme-system spec's "WCAG AA contrast across the rendered pair matrix" requirement.
 *
 * Each {@link Surface} row is one (foreground token, background roles, threshold) tuple that some TUI
 * component ACTUALLY renders, tagged with that component (the `ref`). This test measures WCAG 2.1
 * relative-luminance contrast for every row × every background × every built-in theme (500 pairs) and
 * fails, naming the theme/pair/ratio/threshold, if any pair drops below its floor: 4.5:1 for text,
 * 3:1 for non-text UI (borders, focus frames) and the decorative `fgSubtle` tier.
 *
 * Two matrix conventions worth knowing before editing a row:
 *  - `bgActive` is a background for EVERY chat-stream text token, not just interactive states: under a
 *    light theme the selection highlight flattens the background to `bgActive` while keeping each
 *    token's foreground (`applySelectionColors` in `app.tsx`), so selected body text and selected code
 *    must both stay readable on it.
 *  - `onAccent`'s backgrounds are the FILLED roles it is drawn on (`accent` for the confirm button,
 *    `error` for the error banner), not surface roles — so its row lists color roles that are
 *    themselves foreground tokens.
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

/** One rendered contrast constraint: a foreground token, the background roles it renders on, its floor, and the component(s) that render it. */
type Surface = {
    /** Human label used in the failure message (e.g. `"fg"`, `"syntax.keyword"`). */
    token: string;
    /** Resolves the foreground hex from a theme (a color role or a syntax scope's `fg`). */
    fg: (t: Theme) => string;
    /** The background COLOR roles this foreground is drawn on. */
    on: (keyof ThemeColors)[];
    /** 4.5:1 for text, 3:1 for non-text / decorative. */
    threshold: number;
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
        ref: "body text everywhere; diff context/changed lines on the bands (diff_block.tsx)",
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
        on: ["bg", "bgActive"],
        threshold: NON_TEXT,
        ref: "DECORATIVE tier — unselected gutters, empty meter cells (list_core.tsx, run_block.tsx); 3:1 floor only",
    },
    {
        token: "accent",
        fg: (t) => t.colors.accent,
        on: ["bg", "bgRaised", "bgActive"],
        threshold: TEXT,
        ref: "md headings/lists, status bar title, dialog titles, chat_bar.tsx",
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
        on: ["bg"],
        threshold: NON_TEXT,
        ref: "panel frames (diff_block.tsx, tool_block.tsx, sidebar.tsx, run_block.tsx)",
    },
    { token: "borderFocus", fg: (t) => t.colors.borderFocus, on: ["bg"], threshold: NON_TEXT, ref: "focus frames" },
    {
        token: "onAccent",
        fg: (t) => t.colors.onAccent,
        on: ["accent", "error"],
        threshold: TEXT,
        ref: "confirm button on accent (confirm_dialog.tsx), error banner on error (chat.tsx)",
    },
];

// Code-block scopes. Every syntax token renders in the chat stream's fenced code (via `syntaxStyle()`),
// so each must clear text contrast on `bg` and — because light-theme selection flattens to `bgActive`
// while preserving the token fg — on `bgActive` too.
const SYNTAX_SCOPES: (keyof ThemeSyntax)[] = ["keyword", "string", "comment", "number", "function", "type", "variable", "operator", "punctuation"];
const SYNTAX_SURFACES: Surface[] = SYNTAX_SCOPES.map((scope) => ({
    token: `syntax.${scope}`,
    fg: (t) => t.syntax[scope].fg,
    on: ["bg", "bgActive"],
    threshold: TEXT,
    ref: "code blocks in the chat stream (message_block.tsx via syntaxStyle)",
}));

const SURFACES: Surface[] = [...COLOR_SURFACES, ...SYNTAX_SURFACES];

describe("WCAG AA contrast across the rendered pair matrix", () => {
    // One test per theme: it measures every surface × every background and fails with the full list of
    // violations, each naming theme · token (fg hex) on role (bg hex) = ratio, required threshold · ref.
    for (const id of themeIds) {
        test(`${themes[id].name} (${id}) meets AA on every rendered pair`, () => {
            const theme = themes[id];
            const failures: string[] = [];
            for (const s of SURFACES) {
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
});
