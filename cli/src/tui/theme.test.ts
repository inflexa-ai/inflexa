import { afterEach, describe, expect, test } from "bun:test";
import { parseColor } from "@opentui/core";

import { noticeColor, setTheme, syntaxStyle, theme, themeId } from "./theme.ts";
import { DEFAULT_THEME_ID, markdownStyles, themeIds, themes } from "../lib/design_system.ts";

// The active theme is a module singleton; reset it after each case so order doesn't matter.
afterEach(() => {
    setTheme(DEFAULT_THEME_ID);
});

describe("theme", () => {
    test("setTheme switches the active id and the returned palette", () => {
        setTheme("nord");
        expect(themeId()).toBe("nord");
        expect(theme()).toEqual(themes["nord"].colors);
    });

    test("the default active theme is DEFAULT_THEME_ID's palette", () => {
        setTheme(DEFAULT_THEME_ID);
        expect(theme()).toEqual(themes[DEFAULT_THEME_ID].colors);
    });
});

describe("noticeColor", () => {
    test("maps each notice kind to the active theme's matching role color", () => {
        setTheme(DEFAULT_THEME_ID);
        const colors = themes[DEFAULT_THEME_ID].colors;
        expect(noticeColor("info")).toBe(colors.info);
        expect(noticeColor("warn")).toBe(colors.warning);
        expect(noticeColor("error")).toBe(colors.error);
    });

    test("recolors when the active theme changes", () => {
        setTheme("nord");
        expect(noticeColor("error")).toBe(themes["nord"].colors.error);
    });
});

describe("markdownStyles", () => {
    test("derives markdown markup colors from each theme's palette", () => {
        for (const t of Object.values(themes)) {
            const m = markdownStyles(t.colors);
            expect(m["markup.heading.1"]).toEqual({ fg: t.colors.accent, bold: true });
            expect(m["markup.heading.6"]?.fg).toBe(t.colors.accent);
            expect(m["markup.strong"]).toEqual({ fg: t.colors.fg, bold: true });
            expect(m["markup.link"]?.fg).toBe(t.colors.info);
            expect(m["markup.raw"]?.fg).toBe(t.colors.secondary);
        }
    });

    test("registers a 'default' scope equal to each theme's fg", () => {
        for (const t of Object.values(themes)) {
            expect(markdownStyles(t.colors).default).toEqual({ fg: t.colors.fg });
        }
    });
});

describe("syntaxStyle default scope", () => {
    // Every span the TUI renders WITHOUT a tree-sitter capture (markdown pipe-table data cells, plain
    // text between captures in a fenced block) resolves opentui's "default" scope; if it is unregistered
    // getStyle("default").fg is undefined and opentui paints its built-in #FFFFFF — invisible on light
    // themes. This pins that every theme's built SyntaxStyle carries a "default" fg equal to the theme fg.
    test("every theme's syntaxStyle resolves a 'default' style whose fg is the theme fg", () => {
        for (const id of themeIds) {
            setTheme(id);
            // opentui's getStyle has a quirk — a `hasOwnProperty` check against a Map that is always
            // false — but it still returns the registered def via `.get` (verified empirically here).
            const def = syntaxStyle().getStyle("default");
            expect(def?.fg).toBeDefined();
            // registerStyle stores fg as an RGBA (run through opentui's parseColor), so compare RGBA to
            // RGBA — parse the expected hex the same way rather than round-tripping back to a hex string,
            // so no channel/format normalization can spuriously fail the match.
            const expected = parseColor(themes[id].colors.fg);
            expect(def?.fg && expected.equals(def.fg)).toBe(true);
        }
    });
});
