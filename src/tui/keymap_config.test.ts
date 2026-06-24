import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { __resetKeybindCache, dispatchKey, keybindLabel, leaderSeq, parseChord, resolveKeybind, useBindings, type KeyLike } from "./keymap.ts";
import { withRoot } from "../test_support/solid.ts";
import { writeConfig } from "../lib/config.ts";
import { DEFAULT_THEME_ID } from "../lib/design_system.ts";
import { env } from "../lib/env.ts";

// A fake opentui key event for the dispatcher (mirrors keymap.test.ts's helper).
function key(name: string, mods: Partial<Pick<KeyLike, "ctrl" | "meta" | "option" | "shift">> = {}): KeyLike & { preventDefault: () => void } {
    return { name, ctrl: false, meta: false, option: false, shift: false, ...mods, preventDefault: () => {} };
}

function writeKeybinds(keybinds: Record<string, string>): void {
    writeConfig({ telemetry: false, theme: DEFAULT_THEME_ID, runtime: "docker", leaderTimeout: 2000, keybinds })._unsafeUnwrap();
    __resetKeybindCache(); // keybinds resolve load-once; drop the cache so the new config is read
}

// Each case starts from no config (→ defaults) and a cleared cache, so resolution is deterministic
// regardless of what other test files left in the process-global cache.
beforeEach(() => {
    rmSync(env.configPath, { force: true });
    __resetKeybindCache();
});

afterEach(() => {
    rmSync(env.configPath, { force: true });
    __resetKeybindCache();
});

describe("keybind resolution — defaults", () => {
    test("resolveKeybind returns the default chord for an id", () => {
        expect(resolveKeybind("app.command-palette")).toEqual(parseChord("ctrl+k"));
        expect(resolveKeybind("app.leader")).toEqual(parseChord("ctrl+x"));
    });

    test("keybindLabel renders the resolved chord's label", () => {
        expect(keybindLabel("app.command-palette")).toBe("ctrl+k");
    });

    test("leaderSeq prefixes the suffix with the resolved leader chord", () => {
        expect(leaderSeq("n")).toEqual([parseChord("ctrl+x"), parseChord("n")]);
    });
});

describe("keybind resolution — config override", () => {
    test("a config keybind overrides the default for resolveKeybind/keybindLabel", () => {
        writeKeybinds({ "app.command-palette": "ctrl+p" });
        expect(resolveKeybind("app.command-palette")).toEqual(parseChord("ctrl+p"));
        expect(keybindLabel("app.command-palette")).toBe("ctrl+p");
    });

    test("end-to-end: a remapped command fires on its new chord, not the old default", () => {
        writeKeybinds({ "app.command-palette": "ctrl+p" });
        withRoot(() => {
            let ran = 0;
            useBindings(() => ({ bindings: [{ chord: resolveKeybind("app.command-palette"), run: () => ran++ }] }));

            expect(dispatchKey(key("k", { ctrl: true }))).toBe(false); // the old default no longer triggers it
            expect(ran).toBe(0);
            expect(dispatchKey(key("p", { ctrl: true }))).toBe(true); // the remapped chord does
            expect(ran).toBe(1);
        });
    });
});
