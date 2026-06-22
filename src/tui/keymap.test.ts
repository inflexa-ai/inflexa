import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";

import { GLYPHS } from "../lib/glyphs.ts";
import {
    parseChord,
    parseKeySpec,
    chordLabel,
    matchChord,
    dispatchKey,
    useBindings,
    pushMode,
    pendingSequence,
    leaderActive,
    reachableKeys,
    isFocusedWithin,
    KEYS,
    MODE_BASE,
    MODE_MODAL,
    type KeyLike,
} from "./keymap.ts";

// A fake opentui key event for the dispatcher (KeyLike + preventDefault, optional eventType).
function key(
    name: string,
    mods: Partial<Pick<KeyLike, "ctrl" | "meta" | "option">> = {},
): KeyLike & { preventDefault: () => void; eventType?: "press" | "repeat" | "release" } {
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

    test("a release event is ignored", () => {
        createRoot((dispose) => {
            let ran = 0;
            useBindings(() => ({ bindings: [{ chord: KEYS.enter, run: () => ran++ }] }));

            expect(dispatchKey({ ...key("return"), eventType: "release" })).toBe(false);
            expect(ran).toBe(0);

            dispose();
        });
    });
});

describe("parseKeySpec", () => {
    const leader = { key: "x", ctrl: true };

    test("comma denotes alternatives", () => {
        const alts = parseKeySpec("ctrl+c,ctrl+d", leader);
        expect(alts).toHaveLength(2);
        expect(alts[0]).toEqual([{ key: "c", ctrl: true, alt: false }]);
        expect(alts[1]).toEqual([{ key: "d", ctrl: true, alt: false }]);
    });

    test("<leader> expands to the leader chord as the first stroke", () => {
        const [seq] = parseKeySpec("<leader>n", leader);
        expect(seq).toEqual([leader, { key: "n", ctrl: false, alt: false }]);
    });

    test("spaces denote a multi-stroke sequence", () => {
        const [seq] = parseKeySpec("<leader>g g", leader);
        expect(seq).toHaveLength(3);
    });
});

describe("dispatchKey sequences (leader / chords)", () => {
    const LEADER = { key: "x", ctrl: true };
    const SEQ = [LEADER, { key: "n" }];

    test("a two-stroke sequence holds pending after the first stroke, fires on the second", () => {
        createRoot((dispose) => {
            let ran = 0;
            useBindings(() => ({ bindings: [{ chord: SEQ, run: () => ran++, desc: "New analysis", group: "Analysis" }] }));

            expect(dispatchKey(key("x", { ctrl: true }))).toBe(true); // leader → pending, not fired
            expect(ran).toBe(0);
            expect(pendingSequence()).toHaveLength(1);
            expect(leaderActive()).toBe(true);

            const next = reachableKeys();
            expect(next).toHaveLength(1);
            expect(next[0]!.stroke).toBe("n");
            expect(next[0]!.desc).toBe("New analysis");

            expect(dispatchKey(key("n"))).toBe(true); // completes the sequence
            expect(ran).toBe(1);
            expect(leaderActive()).toBe(false);

            dispose();
        });
    });

    test("escape abandons a pending sequence", () => {
        createRoot((dispose) => {
            let ran = 0;
            useBindings(() => ({ bindings: [{ chord: SEQ, run: () => ran++ }] }));

            dispatchKey(key("x", { ctrl: true }));
            expect(leaderActive()).toBe(true);
            expect(dispatchKey(key("escape"))).toBe(true);
            expect(leaderActive()).toBe(false);
            expect(ran).toBe(0);

            dispose();
        });
    });

    test("backspace pops a stroke from the pending sequence", () => {
        createRoot((dispose) => {
            useBindings(() => ({ bindings: [{ chord: SEQ, run: () => {} }] }));

            dispatchKey(key("x", { ctrl: true }));
            expect(pendingSequence()).toHaveLength(1);
            expect(dispatchKey(key("backspace"))).toBe(true);
            expect(leaderActive()).toBe(false); // popped to empty

            dispose();
        });
    });
});

describe("isFocusedWithin (focus-target gating)", () => {
    test("matches the target itself and any descendant, nothing else", () => {
        // Test doubles: only the fields isFocusedWithin reads (`id`, `findDescendantById`) are
        // present, so a cast through `unknown` to the Renderable param is the minimal stub.
        const child = { id: "child" } as unknown as Parameters<typeof isFocusedWithin>[0];
        const target = {
            id: "target",
            findDescendantById: (id: string) => (id === "child" ? child : undefined),
        } as unknown as Parameters<typeof isFocusedWithin>[0];
        const other = { id: "other" } as unknown as Parameters<typeof isFocusedWithin>[1];

        expect(isFocusedWithin(target, target)).toBe(true);
        expect(isFocusedWithin(target, child)).toBe(true);
        expect(isFocusedWithin(target, other)).toBe(false);
        expect(isFocusedWithin(target, null)).toBe(false);
    });
});
