// Theme registry: the id list, the type shapes, and the palette data. Kept
// dependency-light (no solid-js, no renderer), separate from the reactive accessor
// layer in `src/tui/theme.ts`, which imports this. The ids live here too — and stay
// solid-js-free — so `src/lib/config.ts` can validate the persisted theme (its zod
// enum) without dragging the reactive layer (and solid-js) onto every command path:
// `src/index.ts` reads config at startup for every command (`inf auth login`, `inf auth whoami`, …).

/**
 * Ordered id list — single source of truth for the picker order, the `ThemeId` union,
 * and the config zod enum.
 */
export const themeIds = ["tokyo-night", "catppuccin-mocha", "gruvbox-dark", "nord", "rose-pine"] as const;

export type ThemeId = (typeof themeIds)[number];

export const DEFAULT_THEME_ID: ThemeId = "tokyo-night";

/** Flat color tokens, read by components via `theme().<token>`. */
export type ThemeColors = {
    bg: string;
    bgPanel: string;
    bgFocused: string;
    border: string;
    borderActive: string;
    fg: string;
    muted: string;
    accent: string;
    secondary: string;
    user: string;
    assistant: string;
    selected: string;
    success: string;
    warn: string;
    info: string;
    error: string;
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
    variant: "dark";
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
            bgPanel: "#1f2335",
            bgFocused: "#24283b",
            border: "#414868",
            borderActive: "#7aa2f7",
            fg: "#c0caf5",
            muted: "#565f89",
            accent: "#7aa2f7",
            secondary: "#2ac3de",
            user: "#7dcfff",
            assistant: "#bb9af7",
            selected: "#7dcfff",
            success: "#9ece6a",
            warn: "#e0af68",
            info: "#7dcfff",
            error: "#f7768e",
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
            bgPanel: "#181825",
            bgFocused: "#313244",
            border: "#45475a",
            borderActive: "#89b4fa",
            fg: "#cdd6f4",
            muted: "#6c7086",
            accent: "#89b4fa",
            secondary: "#cba6f7",
            user: "#89dceb",
            assistant: "#cba6f7",
            selected: "#b4befe",
            success: "#a6e3a1",
            warn: "#f9e2af",
            info: "#89dceb",
            error: "#f38ba8",
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
            bgPanel: "#1d2021",
            bgFocused: "#3c3836",
            border: "#504945",
            borderActive: "#fabd2f",
            fg: "#ebdbb2",
            muted: "#928374",
            accent: "#fabd2f",
            secondary: "#83a598",
            user: "#83a598",
            assistant: "#d3869b",
            selected: "#8ec07c",
            success: "#b8bb26",
            warn: "#fe8019",
            info: "#83a598",
            error: "#fb4934",
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
            bgPanel: "#272c36",
            bgFocused: "#3b4252",
            border: "#434c5e",
            borderActive: "#88c0d0",
            fg: "#d8dee9",
            muted: "#616e88",
            accent: "#88c0d0",
            secondary: "#81a1c1",
            user: "#8fbcbb",
            assistant: "#b48ead",
            selected: "#88c0d0",
            success: "#a3be8c",
            warn: "#ebcb8b",
            info: "#81a1c1",
            error: "#bf616a",
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
            bgPanel: "#1f1d2e",
            bgFocused: "#26233a",
            border: "#403d52",
            borderActive: "#c4a7e7",
            fg: "#e0def4",
            muted: "#6e6a86",
            accent: "#c4a7e7",
            secondary: "#f6c177",
            user: "#9ccfd8",
            assistant: "#c4a7e7",
            selected: "#ebbcba",
            success: "#31748f",
            warn: "#f6c177",
            info: "#9ccfd8",
            error: "#eb6f92",
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
};
