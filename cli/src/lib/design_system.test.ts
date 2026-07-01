import { describe, expect, test } from "bun:test";

import { DEFAULT_THEME_ID, MARKERS, themeIds, themes } from "./design_system.ts";

// The color roles every theme must define — anchored to the default theme so the invariant is
// "all themes agree on the same role set" without re-listing the ThemeColors type at runtime.
const colorRoles = Object.keys(themes[DEFAULT_THEME_ID].colors).sort();

describe("theme registry", () => {
    test("DEFAULT_THEME_ID is a registered theme id", () => {
        expect(themeIds).toContain(DEFAULT_THEME_ID);
    });

    test("every theme's id matches its registry key", () => {
        for (const id of themeIds) {
            expect(themes[id].id).toBe(id);
        }
    });

    test("every theme defines exactly the same color roles (no missing or extra)", () => {
        for (const id of themeIds) {
            expect(Object.keys(themes[id].colors).sort()).toEqual(colorRoles);
        }
    });

    test("every color value is a 6-digit hex string", () => {
        for (const id of themeIds) {
            for (const value of Object.values(themes[id].colors)) {
                expect(value).toMatch(/^#[0-9a-fA-F]{6}$/);
            }
        }
    });

    test("every theme declares a dark or light variant", () => {
        for (const id of themeIds) {
            expect(["dark", "light"]).toContain(themes[id].variant);
        }
    });
});

describe("gutter markers", () => {
    test("every marker's role is a valid ThemeColors role", () => {
        for (const marker of Object.values(MARKERS)) {
            expect(colorRoles).toContain(marker.role);
        }
    });

    test("every marker glyph is a single terminal cell (one code point)", () => {
        for (const marker of Object.values(MARKERS)) {
            expect([...marker.glyph].length).toBe(1);
        }
    });
});
