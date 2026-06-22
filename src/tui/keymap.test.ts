import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";

import { GLYPHS } from "../lib/glyphs.ts";
import { parseChord, chordLabel, matchChord, dispatchKey, useBindings, pushMode, KEYS, MODE_BASE, MODE_MODAL, type KeyLike } from "./keymap.ts";

// A fake opentui key event for the dispatcher (KeyLike + preventDefault).
function key(name: string, mods: Partial<Pick<KeyLike, "ctrl" | "meta" | "option">> = {}): KeyLike & { preventDefault: () => void } {
    return { name, ctrl: false, meta: false, option: false, ...mods, preventDefault: () => {} };
}

describe("parseChord / chordLabel", () => {
    test("parses modifiers and canonicalizes friendly names", () => {
        expect(parseChord("ctrl+k")).toEqual({ key: "k", ctrl: true, alt: false });
        expect(parseChord("enter")).toEqual({ key: "return", ctrl: false, alt: false });
        expect(parseChord("alt+enter")).toEqual({ key: "return", ctrl: false, alt: true });
        // opt/option are Alt aliases.
        expect(parseChord("opt+x").alt).toBe(true);
        expect(parseChord("option+x").alt).toBe(true);
    });

    test("labels are lowercase and platform-neutral; arrows render as glyphs", () => {
        expect(chordLabel({ key: "k", ctrl: true })).toBe("ctrl+k");
        expect(chordLabel({ key: "return" })).toBe("enter");
        expect(chordLabel({ key: "escape" })).toBe("esc");
        expect(chordLabel(KEYS.up)).toBe(GLYPHS.arrowUp);
    });

    test("a key string round-trips through parse → label", () => {
        expect(chordLabel(parseChord("ctrl+b"))).toBe("ctrl+b");
        expect(chordLabel(parseChord("alt+enter"))).toBe("alt+enter");
    });
});

describe("matchChord", () => {
    test("requires the exact modifier set", () => {
        expect(matchChord({ key: "k", ctrl: true }, key("k", { ctrl: true }))).toBe(true);
        // A modifier the chord does not require must be absent.
        expect(matchChord({ key: "k" }, key("k", { ctrl: true }))).toBe(false);
        expect(matchChord({ key: "k", ctrl: true }, key("k"))).toBe(false);
    });

    test("Alt is accepted from EITHER meta or option (terminals deliver it inconsistently)", () => {
        expect(matchChord({ key: "return", alt: true }, key("return", { meta: true }))).toBe(true);
        expect(matchChord({ key: "return", alt: true }, key("return", { option: true }))).toBe(true);
        // A non-Alt chord must reject an Alt-bearing event.
        expect(matchChord({ key: "return" }, key("return", { meta: true }))).toBe(false);
    });
});

describe("dispatchKey arbitration", () => {
    test("a MODE_BASE layer is suspended when MODE_MODAL is pushed", () => {
        createRoot((dispose) => {
            let ran = 0;
            useBindings(() => ({ mode: MODE_BASE, bindings: [{ chord: KEYS.enter, run: () => ran++ }] }));

            expect(dispatchKey(key("return"))).toBe(true);
            expect(ran).toBe(1);

            const pop = pushMode(MODE_MODAL);
            expect(dispatchKey(key("return"))).toBe(false); // base layer now inert
            expect(ran).toBe(1);

            pop();
            dispose();
        });
    });

    test("enabled is re-read per keystroke (the thunk's lazy eval IS the reactivity)", () => {
        createRoot((dispose) => {
            let ran = 0;
            let on = false;
            useBindings(() => ({ enabled: on, bindings: [{ chord: KEYS.enter, run: () => ran++ }] }));

            expect(dispatchKey(key("return"))).toBe(false);
            on = true;
            expect(dispatchKey(key("return"))).toBe(true);
            expect(ran).toBe(1);

            dispose();
        });
    });

    test("higher priority wins a chord conflict", () => {
        createRoot((dispose) => {
            const order: string[] = [];
            useBindings(() => ({ priority: 1, bindings: [{ chord: KEYS.enter, run: () => order.push("low") }] }));
            useBindings(() => ({ priority: 10, bindings: [{ chord: KEYS.enter, run: () => order.push("high") }] }));

            dispatchKey(key("return"));
            expect(order).toEqual(["high"]);

            dispose();
        });
    });

    test("a matched binding is preventDefault'd by default", () => {
        createRoot((dispose) => {
            let prevented = 0;
            useBindings(() => ({ bindings: [{ chord: KEYS.enter, run: () => {} }] }));

            dispatchKey({ ...key("return"), preventDefault: () => prevented++ });
            expect(prevented).toBe(1);

            dispose();
        });
    });
});
