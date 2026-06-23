import { afterEach, describe, expect, test } from "bun:test";

import { noticeColor, setTheme, theme, themeId } from "./theme.ts";
import { DEFAULT_THEME_ID, themes } from "../lib/design_system.ts";

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
