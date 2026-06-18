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
    // --- Light variants (palettes sourced from opencode's light theme defs) ---
    "catppuccin-latte": {
        id: "catppuccin-latte",
        name: "Catppuccin Latte",
        variant: "light",
        colors: {
            bg: "#eff1f5",
            bgPanel: "#e6e9ef",
            bgFocused: "#ccd0da",
            border: "#bcc0cc",
            borderActive: "#1e66f5",
            fg: "#4c4f69",
            muted: "#8c8fa1",
            accent: "#1e66f5",
            secondary: "#8839ef",
            user: "#04a5e5",
            assistant: "#8839ef",
            selected: "#7287fd",
            success: "#40a02b",
            warn: "#df8e1d",
            info: "#04a5e5",
            error: "#d20f39",
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
            bgPanel: "#f6f8fa",
            bgFocused: "#f0f3f6",
            border: "#d0d7de",
            borderActive: "#0969da",
            fg: "#24292f",
            muted: "#57606a",
            accent: "#0969da",
            secondary: "#8250df",
            user: "#1b7c83",
            assistant: "#8250df",
            selected: "#0969da",
            success: "#1a7f37",
            warn: "#9a6700",
            info: "#1b7c83",
            error: "#cf222e",
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
            bgPanel: "#eee8d5",
            bgFocused: "#eee8d5",
            border: "#93a1a1",
            borderActive: "#268bd2",
            fg: "#657b83",
            muted: "#93a1a1",
            accent: "#268bd2",
            secondary: "#6c71c4",
            user: "#2aa198",
            assistant: "#6c71c4",
            selected: "#2aa198",
            success: "#859900",
            warn: "#b58900",
            info: "#2aa198",
            error: "#dc322f",
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
            bgPanel: "#ebdbb2",
            bgFocused: "#d5c4a1",
            border: "#bdae93",
            borderActive: "#b57614",
            fg: "#3c3836",
            muted: "#7c6f64",
            accent: "#b57614",
            secondary: "#076678",
            user: "#076678",
            assistant: "#8f3f71",
            selected: "#427b58",
            success: "#79740e",
            warn: "#af3a03",
            info: "#076678",
            error: "#9d0006",
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
            bgPanel: "#f0f0f1",
            bgFocused: "#eaeaeb",
            border: "#d1d1d2",
            borderActive: "#4078f2",
            fg: "#383a42",
            muted: "#a0a1a7",
            accent: "#4078f2",
            secondary: "#a626a4",
            user: "#0184bc",
            assistant: "#a626a4",
            selected: "#4078f2",
            success: "#50a14f",
            warn: "#c18401",
            info: "#0184bc",
            error: "#e45649",
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
