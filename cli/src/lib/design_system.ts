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
    /**
     * U+2800-block braille frames (fixed single-cell width) cycled as the live "thinking" spinner.
     * The classic 10-frame `dots` sequence: more frames + smaller per-step motion than a 4-frame
     * circle, so it reads as smooth continuous spin rather than a choppy quarter-flip.
     */
    spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
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
// `src/index.ts` reads config at startup for every command (`inflexa auth login`, …).

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
    /** The floor for information-bearing secondary text — labels, meta, hints. Held to AA text contrast (≥4.5:1). */
    fgMuted: string;
    /**
     * Decorative-only third tier: content whose loss does not impair task completion — unselected gutter
     * glyphs, empty meter cells, separators. Exempt from the 4.5:1 text threshold as pure decoration, but
     * MUST stay ≥3:1 against every background it renders on. Information-bearing text (hints, durations,
     * ids, meta) uses `fgMuted` or stronger — retuning this tier to 4.5:1 would collapse it into `fgMuted`.
     */
    fgSubtle: string;
    /**
     * Subtle dividers and frames. Held to the 3:1 non-text floor against `bg` **and** `bgRaised`: a
     * bordered box paints its border glyphs on its own `backgroundColor`, so a frame around a raised
     * panel (tool results, the sidebar, dialogs) never renders against `bg`.
     */
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
    /**
     * Row band painted behind an *added* diff line. A per-theme tint of `success` toward `bg` —
     * dark bands on dark themes, light pastel bands on light themes — chosen so the diff text
     * (`fg`) stays AA-readable (≥4.5:1) on the band while the band stays distinct from `bg`
     * (≥1.2:1, the weight of the weakest band opentui itself ships). Replaces opentui's hardcoded
     * dark-only `#1a4d1a`, which is wrong on light themes. Both floors are enforced by the matrix.
     */
    diffAddedBg: string;
    /** Row band painted behind a *removed* diff line — the matching `error`-toward-`bg` tint; see {@link ThemeColors.diffAddedBg}. */
    diffRemovedBg: string;
};

/**
 * Per-scope styling for fenced code blocks, applied via SyntaxStyle.fromStyles.
 * Keys are the tree-sitter capture scopes the markdown highlighter emits.
 */
export type SyntaxEntry = { fg: string; bold?: boolean; italic?: boolean };

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

/**
 * Markdown rendering colors, derived from a theme's palette so every theme gets consistent
 * heading / emphasis / link / list styling without each repeating it. The `<markdown>` highlighter
 * emits these `markup.*` capture scopes (opentui's bundled `assets/markdown` + `markdown_inline`
 * highlight queries); `ThemeSyntax` covers the code-block scopes, this covers the prose ones.
 *
 * Heading levels are listed individually on purpose: opentui's `SyntaxStyle.getStyle` only falls a
 * scope back to its FIRST segment (`markup.heading.1` → `markup`), never to `markup.heading`, so a
 * lone `markup.heading` parent would not catch them. A terminal can't size an H1, so the structure
 * has to read from color and weight alone.
 *
 * Two entries below are not prose captures — `default` and `conceal`. Each closes a path where
 * opentui would otherwise paint a color that belongs to no palette; see their comments.
 */
export function markdownStyles(c: ThemeColors): Record<string, SyntaxEntry> {
    const heading: SyntaxEntry = { fg: c.accent, bold: true };
    const link: SyntaxEntry = { fg: c.info };
    return {
        // opentui resolves the `"default"` scope for every span it emits with NO tree-sitter capture:
        // markdown pipe-table data cells (the Markdown renderable builds its TextTable child WITHOUT
        // forwarding `fg`, so this scope is the only lever there) and plain text between captures inside
        // a fenced block. Without a registered `"default"`, `getStyle("default")` is `undefined` and
        // those spans fall through to opentui's built-in #FFFFFF foreground — invisible on light themes.
        default: { fg: c.fg },
        // opentui resolves `conceal` for the markdown chrome it draws itself, not for prose. Blockquote
        // bars and horizontal rules read `getStyle("conceal")?.fg ?? getStyle("default")?.fg`, so leaving
        // it unset paints structural dividers at full body-text weight; pipe-table frames read
        // `getStyle("conceal")?.fg ?? "#888888"`, a gray no palette owns (unreachable while
        // `internalBlockMode="top-level"` renders tables as borderless columns, but one option away).
        // All three are frames, so they take `border`. The `#`/`*`/`` ` `` markers this scope also
        // captures are elided before styling, so coloring it cannot touch prose.
        conceal: { fg: c.border },
        markup: { fg: c.fg }, // base: first-segment fallback for any markup.* not set below
        "markup.heading": heading,
        "markup.heading.1": heading,
        "markup.heading.2": heading,
        "markup.heading.3": heading,
        "markup.heading.4": heading,
        "markup.heading.5": heading,
        "markup.heading.6": heading,
        "markup.strong": { fg: c.fg, bold: true },
        "markup.italic": { fg: c.fg, italic: true },
        "markup.strikethrough": { fg: c.fgMuted },
        "markup.quote": { fg: c.fgMuted, italic: true },
        "markup.link": link,
        "markup.link.label": link,
        "markup.link.url": link,
        "markup.list": { fg: c.accent },
        "markup.list.checked": { fg: c.success },
        "markup.list.unchecked": { fg: c.fgMuted },
        "markup.raw": { fg: c.secondary }, // inline `code`; fenced blocks are colored by the injected grammar
    };
}

export type Theme = {
    id: ThemeId;
    name: string;
    /** Light vs dark base. Documents the palette's intent for the picker, and drives the chat selection
     * highlight style (dark → native per-token inversion, light → flat highlight; see applySelectionColors). */
    variant: "dark" | "light";
    colors: ThemeColors;
    syntax: ThemeSyntax;
};

export const themes: Record<ThemeId, Theme> = {
    // Tokyo-Night-derived: keeps the recognizable Tokyo Night hue character, but the foreground
    // tokens that failed the AA contrast matrix (fgMuted, fgSubtle, border, syntax.comment) are
    // retuned by hue-locked OKLCH lightness to clear it, so the palette is no longer byte-for-byte
    // the upstream/pre-themes values. The matrix is enforced by design_system.contrast.test.ts.
    "tokyo-night": {
        id: "tokyo-night",
        name: "Tokyo Night",
        variant: "dark",
        colors: {
            bg: "#1a1b26",
            bgRaised: "#1f2335",
            bgActive: "#24283b",
            fg: "#c0caf5",
            fgMuted: "#838eba",
            fgSubtle: "#687192",
            border: "#646c8e",
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
            diffAddedBg: "#323b32",
            diffRemovedBg: "#422b39",
        },
        syntax: {
            keyword: { fg: "#bb9af7" },
            string: { fg: "#9ece6a" },
            comment: { fg: "#838eba", italic: true },
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
            fgMuted: "#959ab1",
            fgSubtle: "#777b91",
            border: "#66687d",
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
            diffAddedBg: "#364143",
            diffRemovedBg: "#443244",
        },
        syntax: {
            keyword: { fg: "#cba6f7" },
            string: { fg: "#a6e3a1" },
            comment: { fg: "#959ab1", italic: true },
            number: { fg: "#fab387" },
            function: { fg: "#89b4fa" },
            type: { fg: "#f9e2af" },
            variable: { fg: "#cdd6f4" },
            operator: { fg: "#89dceb" },
            punctuation: { fg: "#949ab3" },
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
            fgMuted: "#ae9f8f",
            fgSubtle: "#8a8077",
            border: "#77706b",
            borderFocus: "#fabd2f",
            onAccent: "#282828",
            accent: "#fabd2f",
            secondary: "#86a99c",
            success: "#b8bb26",
            warning: "#fe8019",
            error: "#ff4f39",
            info: "#83a598",
            user: "#83a598",
            assistant: "#d3869b",
            tool: "#83a598",
            thinking: "#fe8019",
            diffAddedBg: "#454528",
            diffRemovedBg: "#522f2a",
        },
        syntax: {
            keyword: { fg: "#ff7964" },
            string: { fg: "#b8bb26" },
            comment: { fg: "#ae9f8f", italic: true },
            number: { fg: "#d98ba0" },
            function: { fg: "#8ec07c" },
            type: { fg: "#fabd2f" },
            variable: { fg: "#ebdbb2" },
            operator: { fg: "#8ec07c" },
            punctuation: { fg: "#afa08a" },
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
            fgMuted: "#a0aeca",
            fgSubtle: "#828da2",
            border: "#737d90",
            borderFocus: "#88c0d0",
            onAccent: "#2e3440",
            accent: "#88c0d0",
            secondary: "#90b1d1",
            success: "#a3be8c",
            warning: "#ebcb8b",
            error: "#e17f87",
            info: "#81a1c1",
            user: "#8fbcbb",
            assistant: "#b690af",
            tool: "#81a1c1",
            thinking: "#ebcb8b",
            diffAddedBg: "#45504f",
            diffRemovedBg: "#4b3d48",
        },
        syntax: {
            keyword: { fg: "#90b1d1" },
            string: { fg: "#a3be8c" },
            comment: { fg: "#a0aeca", italic: true },
            number: { fg: "#c9a2c1" },
            function: { fg: "#88c0d0" },
            type: { fg: "#8fbcbb" },
            variable: { fg: "#d8dee9" },
            operator: { fg: "#90b1d1" },
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
            fgMuted: "#8d89a6",
            fgSubtle: "#6f6c85",
            border: "#6a677d",
            borderFocus: "#c4a7e7",
            onAccent: "#191724",
            accent: "#c4a7e7",
            secondary: "#f6c177",
            success: "#5394b0",
            warning: "#f6c177",
            error: "#eb6f92",
            info: "#9ccfd8",
            user: "#9ccfd8",
            assistant: "#c4a7e7",
            tool: "#9ccfd8",
            thinking: "#f6c177",
            diffAddedBg: "#1e2a39",
            diffRemovedBg: "#43293a",
        },
        syntax: {
            keyword: { fg: "#5394b0" },
            string: { fg: "#f6c177" },
            comment: { fg: "#8d89a6", italic: true },
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
            fgMuted: "#565869",
            fgSubtle: "#717484",
            border: "#828591",
            borderFocus: "#1e66f5",
            onAccent: "#eff1f5",
            accent: "#004bd7",
            secondary: "#781fdb",
            success: "#196800",
            warning: "#804e00",
            error: "#b5002e",
            info: "#005f87",
            user: "#005f87",
            assistant: "#781fdb",
            tool: "#005f87",
            thinking: "#804e00",
            diffAddedBg: "#d0e0d2",
            diffRemovedBg: "#ebcfd9",
        },
        syntax: {
            keyword: { fg: "#781fdb" },
            string: { fg: "#196800" },
            comment: { fg: "#56586b", italic: true },
            number: { fg: "#9d3900" },
            function: { fg: "#004bd7" },
            type: { fg: "#804e00" },
            variable: { fg: "#4c4f69" },
            operator: { fg: "#005f87" },
            punctuation: { fg: "#56586b" },
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
            fgSubtle: "#858d97",
            border: "#8a9097",
            borderFocus: "#0969da",
            onAccent: "#ffffff",
            accent: "#0969da",
            secondary: "#8250df",
            success: "#1a7f37",
            warning: "#966400",
            error: "#cf222e",
            info: "#187a81",
            user: "#187a81",
            assistant: "#8250df",
            tool: "#187a81",
            thinking: "#966400",
            diffAddedBg: "#dfede3",
            diffRemovedBg: "#f8e0e2",
        },
        syntax: {
            keyword: { fg: "#cf222e" },
            string: { fg: "#0a3069" },
            comment: { fg: "#68707a", italic: true },
            number: { fg: "#0550ae" },
            function: { fg: "#8250df" },
            type: { fg: "#bc4c00" },
            variable: { fg: "#24292f" },
            operator: { fg: "#187a81" },
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
            // Solarized's canonical `fg` (#657b83) is only 4.13:1 on `bg` — sub-AA — so this palette
            // deviates from upstream, darkening every foreground for AA. `fg` is darkened past its own
            // 4.5:1 minimum on purpose: a diff band sits between `fg` and `bg`, and the two contrast
            // ratios multiply exactly, so a band can only clear the 1.2:1 distinctness floor while
            // keeping `fg` readable on it when contrast(fg, bg) ≥ 4.5 × 1.2. Solarized's near-white
            // `bg` leaves no other source of that headroom.
            fg: "#4f646c",
            fgMuted: "#5e6b6b",
            fgSubtle: "#7f8686",
            border: "#7b8787",
            borderFocus: "#268bd2",
            onAccent: "#fdf6e3",
            accent: "#006dad",
            secondary: "#5d60b2",
            success: "#606f00",
            warning: "#846300",
            error: "#cd1e21",
            info: "#00756e",
            user: "#00756e",
            assistant: "#5d60b2",
            tool: "#00756e",
            thinking: "#846300",
            diffAddedBg: "#e5e2be",
            diffRemovedBg: "#f7dbca",
        },
        syntax: {
            keyword: { fg: "#606f00" },
            string: { fg: "#00756e" },
            comment: { fg: "#5e6b6b", italic: true },
            number: { fg: "#c22374" },
            function: { fg: "#006dad" },
            type: { fg: "#846300" },
            variable: { fg: "#576c74" },
            operator: { fg: "#606f00" },
            punctuation: { fg: "#576c74" },
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
            fgMuted: "#5d5046",
            fgSubtle: "#796b57",
            border: "#897a61",
            borderFocus: "#ad6f02",
            onAccent: "#fbf1c7",
            accent: "#754900",
            secondary: "#005b6c",
            success: "#595400",
            warning: "#962f00",
            error: "#9d0006",
            info: "#005b6c",
            user: "#005b6c",
            assistant: "#843567",
            tool: "#005b6c",
            thinking: "#962f00",
            diffAddedBg: "#e6dca9",
            diffRemovedBg: "#edcdaa",
        },
        syntax: {
            keyword: { fg: "#9d0006" },
            string: { fg: "#595400" },
            comment: { fg: "#5d5046", italic: true },
            number: { fg: "#843567" },
            function: { fg: "#245d3c" },
            type: { fg: "#754900" },
            variable: { fg: "#3c3836" },
            operator: { fg: "#245d3c" },
            punctuation: { fg: "#5d5046" },
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
            fgMuted: "#69696f",
            fgSubtle: "#86868c",
            border: "#8a8a8b",
            borderFocus: "#4078f2",
            onAccent: "#fafafa",
            accent: "#2d62db",
            secondary: "#a626a4",
            success: "#267928",
            warning: "#8f6000",
            error: "#c2352c",
            info: "#0070a1",
            user: "#0070a1",
            assistant: "#a626a4",
            tool: "#0070a1",
            thinking: "#8f6000",
            diffAddedBg: "#dce8dc",
            diffRemovedBg: "#f4e0de",
        },
        syntax: {
            keyword: { fg: "#a626a4" },
            string: { fg: "#267928" },
            comment: { fg: "#69696f", italic: true },
            number: { fg: "#8f6100" },
            function: { fg: "#2d62db" },
            type: { fg: "#8f6100" },
            variable: { fg: "#383a42" },
            operator: { fg: "#0071a1" },
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

/**
 * Named dialog size presets — the single source of truth for dialog panel dimensions,
 * the way `space` is for padding and `stroke` is for borders. Widths are FIXED column
 * counts (OpenCode's proven 60-ish/88/116 tiers) clamped by a percentage: a panel's
 * readable line length doesn't scale with monitor size, so a percentage is only right
 * as the small-terminal escape hatch, never as the dimension itself. Heights follow the
 * same fixed+clamp shape for the tiers whose content CHANGES while open (`lg` pickers
 * filter, `xl` showcases scroll) — a panel that resizes as its list filters is worse UX
 * than trailing empty rows, so those tiers hold their defined height. Only `md` is
 * content-height: its content (a prompt line, a confirm message) is static for the
 * dialog's lifetime, so nothing can shrink mid-interaction. Never pair percentage width
 * with percentage height: terminal cells are ~2× taller than wide, so equal-ish
 * percentages render square/portrait panels whose proportions track the terminal's
 * instead of the content's.
 */
export const dialogSize = {
    /** Short prompts, confirms, alerts — static content, content height. */
    md: { width: 64, maxWidth: "90%", height: undefined, maxHeight: "80%" },
    /** Pickers, lists, results — fixed rows so filtering never resizes the panel. */
    lg: { width: 88, maxWidth: "90%", height: 20, maxHeight: "80%" },
    /** Full showcases, galleries, large forms — near-full-screen. */
    xl: { width: 116, maxWidth: "90%", height: "85%", maxHeight: undefined },
} as const satisfies Record<string, DialogDims>;

/** The dimension set a dialog preset carries — consumed by `DialogPanel`, never raw call sites. */
export type DialogDims = {
    /** Fixed panel width in columns (readable line length, not terminal-relative). */
    width: number;
    /** Small-terminal clamp so the fixed width never overflows. */
    maxWidth: `${number}%`;
    /** Fixed panel height (rows or terminal fraction); `undefined` = content-height (`md` only). */
    height: number | `${number}%` | undefined;
    /** Small-terminal clamp for fixed-row heights / scroll cap for the content-height tier. */
    maxHeight: `${number}%` | undefined;
};

/** A dialog size preset key. */
export type DialogSize = keyof typeof dialogSize;

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
