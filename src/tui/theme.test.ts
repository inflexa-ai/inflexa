import { afterEach, describe, expect, test } from "bun:test";

import { noticeColor, setTheme, theme, themeId } from "./theme.ts";
import { DEFAULT_THEME_ID, markdownStyles, themes } from "../lib/design_system.ts";

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
});
