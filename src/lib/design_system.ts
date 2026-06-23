// The design system: every non-color and color *primitive* the TUI is built from,
// merged into one module — glyphs, the theme registry, layout tokens, the stacking
// ladder, and the gutter marker set. Previously five files (`glyphs.ts`, `themes.ts`,
// `z_index.ts`, `tui/tokens.ts`, `tui/markers.ts`); folded together so the whole
// vocabulary reads as one design system.
//
// Lives in `lib/` (not `tui/`) on purpose: `lib/config.ts` imports `themeIds`/
// `DEFAULT_THEME_ID` to validate the persisted theme on EVERY command path, and
// infrastructure must never import presentation — a `tui/` home would invert that.
// Everything here is plain data: NO solid-js, NO JSX, NO reactivity. The reactive
// accessor over the theme data is `src/tui/theme.ts`; any signal/JSX design-system
// helper (e.g. the emphasis components) lives under `src/tui/components/`, never here.

// ─────────────────────────────────────────────────────────────────────────────
// Glyphs
// ─────────────────────────────────────────────────────────────────────────────

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
 * carry domain meaning map their role onto a shape here — see the `MARKERS` set below (gutter kinds)
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
    /** U+25CB — hollow circle: a not-yet-started item (a queued run step). */
    circleHollow: "○",
    /** U+25D0 — half-filled circle: in-progress / busy (chat `thinking` status). */
    circleHalf: "◐",
    /** U+25AE — filled vertical bar: one cell of a progress meter. */
    bar: "▮",
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

// ─────────────────────────────────────────────────────────────────────────────
// Theme registry: id list, type shapes, palette data
// ─────────────────────────────────────────────────────────────────────────────
//
// Kept solid-js-free and renderer-free. The reactive accessor layer lives in
// `src/tui/theme.ts`, which imports from here. The ids live here too so
// `src/lib/config.ts` can validate the persisted theme (its zod enum) without
// dragging the reactive layer (and solid-js) onto every command path:
// `src/index.ts` reads config at startup for every command (`inf auth login`, …).

/**
 * Ordered id list — single source of truth for the picker order, the `ThemeId` union,
 * and the config zod enum.
 */
export const themeIds = [
    // Dark variants first (the default group), then the popular light variants.
    "tokyo-night",
    "catppuccin-mocha",
    "gruvbox-dark",
    "nord",
    "rose-pine",
    "catppuccin-latte",
    "github-light",
    "solarized-light",
    "gruvbox-light",
    "one-light",
] as const;

export type ThemeId = (typeof themeIds)[number];

export const DEFAULT_THEME_ID: ThemeId = "tokyo-night";

/**
 * Flat semantic color roles, read by components via `theme().<role>`. The
 * vocabulary follows the functional grouping common to Material 3, MUI, GitHub
 * Primer, IBM Carbon, Catppuccin and Radix: three foreground tiers, two border
 * tiers, an explicit on-color, the four status roles, and a few domain roles —
 * grouped by `bg*`/`fg*`/`border*` prefix (Primer style) for the smallest churn
 * from the prior names while staying standard. No hex is inlined at call sites.
 */
export type ThemeColors = {
    /** App background. */
    bg: string;
    /** Elevated chrome: header/status bars, the rail, panels. */
    bgRaised: string;
    /** Hovered / selected / focused element background. */
    bgActive: string;
    /** Primary text. */
    fg: string;
    /** Secondary text: labels, meta. */
    fgMuted: string;
    /** Faint text: hints, disabled, separators. The standard third foreground tier. */
    fgSubtle: string;
    /** Subtle dividers and frames. */
    border: string;
    /** Focused / active region border. */
    borderFocus: string;
    /** Text/icons placed on a filled accent or status background. */
    onAccent: string;
    /** Primary accent: focus, links. */
    accent: string;
    /** Secondary accent. */
    secondary: string;
    /** Done, ready, additions. */
    success: string;
    /** Caution, running, reasoning-adjacent. */
    warning: string;
    /** Errors, aborts, deletions. */
    error: string;
    /** Informational notices. */
    info: string;
    /** Domain: the user's turn. */
    user: string;
    /** Domain: the assistant's turn (and ids/slugs/code). */
    assistant: string;
    /** Domain: tool / verb names. */
    tool: string;
    /** Domain: reasoning / thinking blocks. */
    thinking: string;
};

/**
 * Per-scope styling for fenced code blocks, applied via SyntaxStyle.fromStyles.
 * Keys are the tree-sitter capture scopes the markdown highlighter emits.
 */
type SyntaxEntry = { fg: string; bold?: boolean; italic?: boolean };

export type ThemeSyntax = {
    keyword: SyntaxEntry;
    string: SyntaxEntry;
    comment: SyntaxEntry;
    number: SyntaxEntry;
    function: SyntaxEntry;
    type: SyntaxEntry;
    variable: SyntaxEntry;
    operator: SyntaxEntry;
    punctuation: SyntaxEntry;
};

export type Theme = {
    id: ThemeId;
    name: string;
    /** Light vs dark base — drives nothing in code today; documents the palette's intent for the picker. */
    variant: "dark" | "light";
    colors: ThemeColors;
    syntax: ThemeSyntax;
};

export const themes: Record<ThemeId, Theme> = {
    // tokyo-night colors are byte-for-byte the palette shipped before themes
    // existed, so the default look is unchanged.
    "tokyo-night": {
        id: "tokyo-night",
        name: "Tokyo Night",
        variant: "dark",
        colors: {
            bg: "#1a1b26",
            bgRaised: "#1f2335",
            bgActive: "#24283b",
            fg: "#c0caf5",
            fgMuted: "#565f89",
            fgSubtle: "#3b4261",
            border: "#414868",
            borderFocus: "#7aa2f7",
            onAccent: "#1a1b26",
            accent: "#7aa2f7",
            secondary: "#2ac3de",
            success: "#9ece6a",
            warning: "#e0af68",
            error: "#f7768e",
            info: "#7dcfff",
            user: "#7dcfff",
            assistant: "#bb9af7",
            tool: "#7dcfff",
            thinking: "#e0af68",
        },
        syntax: {
            keyword: { fg: "#bb9af7" },
            string: { fg: "#9ece6a" },
            comment: { fg: "#565f89", italic: true },
            number: { fg: "#ff9e64" },
            function: { fg: "#7aa2f7" },
            type: { fg: "#2ac3de" },
            variable: { fg: "#c0caf5" },
            operator: { fg: "#89ddff" },
            punctuation: { fg: "#a9b1d6" },
        },
    },
    "catppuccin-mocha": {
        id: "catppuccin-mocha",
        name: "Catppuccin Mocha",
        variant: "dark",
        colors: {
            bg: "#1e1e2e",
            bgRaised: "#181825",
            bgActive: "#313244",
            fg: "#cdd6f4",
            fgMuted: "#6c7086",
            fgSubtle: "#585b70",
            border: "#45475a",
            borderFocus: "#89b4fa",
            onAccent: "#1e1e2e",
            accent: "#89b4fa",
            secondary: "#cba6f7",
            success: "#a6e3a1",
            warning: "#f9e2af",
            error: "#f38ba8",
            info: "#89dceb",
            user: "#89dceb",
            assistant: "#cba6f7",
            tool: "#89dceb",
            thinking: "#f9e2af",
        },
        syntax: {
            keyword: { fg: "#cba6f7" },
            string: { fg: "#a6e3a1" },
            comment: { fg: "#6c7086", italic: true },
            number: { fg: "#fab387" },
            function: { fg: "#89b4fa" },
            type: { fg: "#f9e2af" },
            variable: { fg: "#cdd6f4" },
            operator: { fg: "#89dceb" },
            punctuation: { fg: "#9399b2" },
        },
    },
    "gruvbox-dark": {
        id: "gruvbox-dark",
        name: "Gruvbox Dark",
        variant: "dark",
        colors: {
            bg: "#282828",
            bgRaised: "#1d2021",
            bgActive: "#3c3836",
            fg: "#ebdbb2",
            fgMuted: "#928374",
            fgSubtle: "#665c54",
            border: "#504945",
            borderFocus: "#fabd2f",
            onAccent: "#282828",
            accent: "#fabd2f",
            secondary: "#83a598",
            success: "#b8bb26",
            warning: "#fe8019",
            error: "#fb4934",
            info: "#83a598",
            user: "#83a598",
            assistant: "#d3869b",
            tool: "#83a598",
            thinking: "#fe8019",
        },
        syntax: {
            keyword: { fg: "#fb4934" },
            string: { fg: "#b8bb26" },
            comment: { fg: "#928374", italic: true },
            number: { fg: "#d3869b" },
            function: { fg: "#8ec07c" },
            type: { fg: "#fabd2f" },
            variable: { fg: "#ebdbb2" },
            operator: { fg: "#8ec07c" },
            punctuation: { fg: "#a89984" },
        },
    },
    nord: {
        id: "nord",
        name: "Nord",
        variant: "dark",
        colors: {
            bg: "#2e3440",
            bgRaised: "#272c36",
            bgActive: "#3b4252",
            fg: "#d8dee9",
            fgMuted: "#616e88",
            fgSubtle: "#4c566a",
            border: "#434c5e",
            borderFocus: "#88c0d0",
            onAccent: "#2e3440",
            accent: "#88c0d0",
            secondary: "#81a1c1",
            success: "#a3be8c",
            warning: "#ebcb8b",
            error: "#bf616a",
            info: "#81a1c1",
            user: "#8fbcbb",
            assistant: "#b48ead",
            tool: "#81a1c1",
            thinking: "#ebcb8b",
        },
        syntax: {
            keyword: { fg: "#81a1c1" },
            string: { fg: "#a3be8c" },
            comment: { fg: "#616e88", italic: true },
            number: { fg: "#b48ead" },
            function: { fg: "#88c0d0" },
            type: { fg: "#8fbcbb" },
            variable: { fg: "#d8dee9" },
            operator: { fg: "#81a1c1" },
            punctuation: { fg: "#d8dee9" },
        },
    },
    "rose-pine": {
        id: "rose-pine",
        name: "Rosé Pine",
        variant: "dark",
        colors: {
            bg: "#191724",
            bgRaised: "#1f1d2e",
            bgActive: "#26233a",
            fg: "#e0def4",
            fgMuted: "#6e6a86",
            fgSubtle: "#524f67",
            border: "#403d52",
            borderFocus: "#c4a7e7",
            onAccent: "#191724",
            accent: "#c4a7e7",
            secondary: "#f6c177",
            success: "#31748f",
            warning: "#f6c177",
            error: "#eb6f92",
            info: "#9ccfd8",
            user: "#9ccfd8",
            assistant: "#c4a7e7",
            tool: "#9ccfd8",
            thinking: "#f6c177",
        },
        syntax: {
            keyword: { fg: "#31748f" },
            string: { fg: "#f6c177" },
            comment: { fg: "#6e6a86", italic: true },
            number: { fg: "#ebbcba" },
            function: { fg: "#ebbcba" },
            type: { fg: "#9ccfd8" },
            variable: { fg: "#e0def4" },
            operator: { fg: "#c4a7e7" },
            punctuation: { fg: "#908caa" },
        },
    },
    // --- Light variants (palettes sourced from opencode's light theme defs) ---
    "catppuccin-latte": {
        id: "catppuccin-latte",
        name: "Catppuccin Latte",
        variant: "light",
        colors: {
            bg: "#eff1f5",
            bgRaised: "#e6e9ef",
            bgActive: "#ccd0da",
            fg: "#4c4f69",
            fgMuted: "#8c8fa1",
            fgSubtle: "#9ca0b0",
            border: "#bcc0cc",
            borderFocus: "#1e66f5",
            onAccent: "#eff1f5",
            accent: "#1e66f5",
            secondary: "#8839ef",
            success: "#40a02b",
            warning: "#df8e1d",
            error: "#d20f39",
            info: "#04a5e5",
            user: "#04a5e5",
            assistant: "#8839ef",
            tool: "#04a5e5",
            thinking: "#df8e1d",
        },
        syntax: {
            keyword: { fg: "#8839ef" },
            string: { fg: "#40a02b" },
            comment: { fg: "#7c7f93", italic: true },
            number: { fg: "#fe640b" },
            function: { fg: "#1e66f5" },
            type: { fg: "#df8e1d" },
            variable: { fg: "#4c4f69" },
            operator: { fg: "#04a5e5" },
            punctuation: { fg: "#7c7f93" },
        },
    },
    "github-light": {
        id: "github-light",
        name: "GitHub Light",
        variant: "light",
        colors: {
            bg: "#ffffff",
            bgRaised: "#f6f8fa",
            bgActive: "#f0f3f6",
            fg: "#24292f",
            fgMuted: "#57606a",
            fgSubtle: "#8c959f",
            border: "#d0d7de",
            borderFocus: "#0969da",
            onAccent: "#ffffff",
            accent: "#0969da",
            secondary: "#8250df",
            success: "#1a7f37",
            warning: "#9a6700",
            error: "#cf222e",
            info: "#1b7c83",
            user: "#1b7c83",
            assistant: "#8250df",
            tool: "#1b7c83",
            thinking: "#9a6700",
        },
        syntax: {
            keyword: { fg: "#cf222e" },
            string: { fg: "#0a3069" },
            comment: { fg: "#57606a", italic: true },
            number: { fg: "#0550ae" },
            function: { fg: "#8250df" },
            type: { fg: "#bc4c00" },
            variable: { fg: "#24292f" },
            operator: { fg: "#1b7c83" },
            punctuation: { fg: "#24292f" },
        },
    },
    "solarized-light": {
        id: "solarized-light",
        name: "Solarized Light",
        variant: "light",
        colors: {
            bg: "#fdf6e3",
            bgRaised: "#eee8d5",
            bgActive: "#eee8d5",
            fg: "#657b83",
            fgMuted: "#93a1a1",
            fgSubtle: "#b0b8b8",
            border: "#93a1a1",
            borderFocus: "#268bd2",
            onAccent: "#fdf6e3",
            accent: "#268bd2",
            secondary: "#6c71c4",
            success: "#859900",
            warning: "#b58900",
            error: "#dc322f",
            info: "#2aa198",
            user: "#2aa198",
            assistant: "#6c71c4",
            tool: "#2aa198",
            thinking: "#b58900",
        },
        syntax: {
            keyword: { fg: "#859900" },
            string: { fg: "#2aa198" },
            comment: { fg: "#93a1a1", italic: true },
            number: { fg: "#d33682" },
            function: { fg: "#268bd2" },
            type: { fg: "#b58900" },
            variable: { fg: "#657b83" },
            operator: { fg: "#859900" },
            punctuation: { fg: "#657b83" },
        },
    },
    "gruvbox-light": {
        id: "gruvbox-light",
        name: "Gruvbox Light",
        variant: "light",
        colors: {
            bg: "#fbf1c7",
            bgRaised: "#ebdbb2",
            bgActive: "#d5c4a1",
            fg: "#3c3836",
            fgMuted: "#7c6f64",
            fgSubtle: "#a89984",
            border: "#bdae93",
            borderFocus: "#b57614",
            onAccent: "#fbf1c7",
            accent: "#b57614",
            secondary: "#076678",
            success: "#79740e",
            warning: "#af3a03",
            error: "#9d0006",
            info: "#076678",
            user: "#076678",
            assistant: "#8f3f71",
            tool: "#076678",
            thinking: "#af3a03",
        },
        syntax: {
            keyword: { fg: "#9d0006" },
            string: { fg: "#79740e" },
            comment: { fg: "#7c6f64", italic: true },
            number: { fg: "#8f3f71" },
            function: { fg: "#427b58" },
            type: { fg: "#b57614" },
            variable: { fg: "#3c3836" },
            operator: { fg: "#427b58" },
            punctuation: { fg: "#7c6f64" },
        },
    },
    "one-light": {
        id: "one-light",
        name: "One Light",
        variant: "light",
        colors: {
            bg: "#fafafa",
            bgRaised: "#f0f0f1",
            bgActive: "#eaeaeb",
            fg: "#383a42",
            fgMuted: "#a0a1a7",
            fgSubtle: "#bcbcc2",
            border: "#d1d1d2",
            borderFocus: "#4078f2",
            onAccent: "#fafafa",
            accent: "#4078f2",
            secondary: "#a626a4",
            success: "#50a14f",
            warning: "#c18401",
            error: "#e45649",
            info: "#0184bc",
            user: "#0184bc",
            assistant: "#a626a4",
            tool: "#0184bc",
            thinking: "#c18401",
        },
        syntax: {
            keyword: { fg: "#a626a4" },
            string: { fg: "#50a14f" },
            comment: { fg: "#a0a1a7", italic: true },
            number: { fg: "#986801" },
            function: { fg: "#4078f2" },
            type: { fg: "#c18401" },
            variable: { fg: "#383a42" },
            operator: { fg: "#0184bc" },
            punctuation: { fg: "#383a42" },
        },
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// Layout tokens — spacing, structural dimensions, border styles
// ─────────────────────────────────────────────────────────────────────────────
//
// The single source of truth for spacing, fixed structural dimensions, and border
// styles, mirroring how `theme()` is the single source for color.
//
// Rule: a raw integer in a layout prop is a smell. If it is spacing it is a
// `space.*`; if it is a structural dimension it is a `size.*`; a `borderStyle`
// is a `stroke.*`. `as const` makes every value a literal type so a typo or an
// out-of-set value fails to compile.

/**
 * Spacing counted in terminal cells (opentui lays out on a character grid, so
 * gaps/paddings/margins are integers, not pixels). Deliberately only three useful
 * steps plus a rare large break — more would invite inconsistency.
 */
export const space = {
    /** 0 — tight pairs: marker│text, glued affixes. */
    none: 0,
    /** 1 — rows within a single block, list items. */
    sm: 1,
    /** 2 — between blocks and between panels. */
    md: 2,
    /** 4 — rare major section breaks. */
    lg: 4,
} as const;

/**
 * Fixed structural dimensions in cells (columns) or rows. Frozen here so the
 * shell's load-bearing measurements are declared once. `railWidth` is the tuned
 * value the sidebar already shipped with (40), not the design doc's example 30.
 */
export const size = {
    /** Marker column width — the fixed gutter every stream block aligns to. */
    gutter: 2,
    /** Status-bar row height. */
    statusBar: 1,
    /** Sidebar / rail width, in columns. */
    railWidth: 40,
    /** Composer minimum height; grows with input. */
    composerMin: 1,
    /** Palette rows visible before it scrolls. */
    paletteRows: 12,
} as const;

/**
 * Border roles mapped to opentui `borderStyle` values. Assigning by role (not by
 * raw style name) lets border weight signal hierarchy: panels are quiet, focused
 * regions are heavy, and the double frame is reserved for destructive confirms.
 */
export const stroke = {
    /** Rail / panel dividers and frames. */
    panel: "single",
    /** Overlays, palette, cards. */
    overlay: "rounded",
    /** The focused / active region. */
    focus: "heavy",
    /** Reserved: destructive confirmation chrome. */
    danger: "double",
} as const;

/** A spacing-scale key (`none` | `sm` | `md` | `lg`). */
export type Space = keyof typeof space;
/** A border-role key (`panel` | `overlay` | `focus` | `danger`). */
export type Stroke = keyof typeof stroke;

// ─────────────────────────────────────────────────────────────────────────────
// Stacking order (z-index ladder)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The single source of stacking order for absolutely-positioned TUI layers, the
 * way `theme` is for colors and `GLYPHS` for glyphs. A stacking order is a
 * cross-cutting contract — layers declared in different files must agree on who
 * sits above whom — so it lives in one named ladder rather than as raw numbers
 * scattered at call sites. The level names follow the de-facto design-system
 * vocabulary (Bootstrap's `$zindex-*`, Chakra's `zIndices`, MUI's `zIndex`).
 *
 * Ordered low → high; higher paints on top. There is deliberately no `0` level:
 * `zIndex={0}` is the default, so a named constant for it would buy nothing.
 * Steps of 10 leave room to slot a new level between two existing ones without
 * renumbering everything below it.
 */
export const zIndex = {
    /** Inline menus opened from in-flow content. */
    dropdown: 10,
    /** Pinned chrome that rides above scrolling content but below modals. */
    sticky: 20,
    /** A modal dialog and the scrim that dims the rest of the screen for it. */
    modal: 30,
    /** Popovers/menus that may open over a modal. */
    popover: 40,
    /** Transient toasts/notices — surface over an open modal. */
    toast: 50,
    /** Ephemeral hover hints — top of the stack, above everything. */
    tooltip: 60,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Gutter markers
// ─────────────────────────────────────────────────────────────────────────────

/** A gutter block kind — the marker that prefixes each stream block in the fixed gutter column. */
export type MarkerKind = "you" | "assistant" | "thinking" | "tool" | "run" | "fileEdit" | "ok" | "error";

/** A gutter marker: its glyph and the theme color role that paints it. */
export type GutterMarker = {
    /** The single-character glyph shown in the fixed gutter column. */
    glyph: string;
    /** An existing `ThemeColors` role (no new tokens) used to color the glyph. */
    role: keyof ThemeColors;
};

/**
 * The shared gutter marker set (the wireframe "shared kit"). One fixed glyph + color role per
 * block kind, so every block type aligns in the same gutter column with only the marker swapping.
 * `MessageBlock` uses the `you`/`assistant` entries today; the remaining six are defined now for
 * the not-yet-built "key moment" block types (thinking / tool / run / file edit / ok / error).
 */
export const MARKERS: Record<MarkerKind, GutterMarker> = Object.freeze({
    // `you`/`assistant` keep plain ASCII chevrons — they read as conversational prompts, not icons,
    // and ASCII has no cross-font drift risk, so they stay literals rather than entering `GLYPHS`.
    you: { glyph: ">", role: "user" },
    assistant: { glyph: "<", role: "assistant" },
    thinking: { glyph: GLYPHS.diamond, role: "thinking" },
    tool: { glyph: GLYPHS.triangleRight, role: "tool" },
    run: { glyph: GLYPHS.circle, role: "warning" },
    fileEdit: { glyph: GLYPHS.pencil, role: "success" },
    ok: { glyph: GLYPHS.check, role: "success" },
    error: { glyph: GLYPHS.cross, role: "error" },
} as const);
