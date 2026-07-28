import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import {
    __resetKeybindCache,
    dispatchKey,
    keybindLabel,
    KEYBIND_DEFAULTS,
    reachableKeys,
    leaderSeq,
    parseChord,
    resolveKeybind,
    useBindings,
    type KeyLike,
} from "./keymap.ts";
import { withRoot } from "../test_support/solid.ts";
import { assertTestSandbox } from "../test_support/sandbox.ts";
import { writeConfig } from "../lib/config.ts";
import { DEFAULT_THEME_ID } from "../lib/design_system.ts";
import { env } from "../lib/env.ts";

// A fake opentui key event for the dispatcher (mirrors keymap.test.ts's helper).
function key(name: string, mods: Partial<Pick<KeyLike, "ctrl" | "meta" | "option" | "shift">> = {}): KeyLike & { preventDefault: () => void } {
    return { name, ctrl: false, meta: false, option: false, shift: false, ...mods, preventDefault: () => {} };
}

function writeKeybinds(keybinds: Record<string, string>): void {
    writeConfig({ telemetry: false, theme: DEFAULT_THEME_ID, runtime: "docker", leaderTimeout: 2000, embedding: { mode: "off" }, keybinds })._unsafeUnwrap();
    __resetKeybindCache(); // keybinds resolve load-once; drop the cache so the new config is read
}

// Each case starts from no config (→ defaults) and a cleared cache, so resolution is deterministic
// regardless of what other test files left in the process-global cache. The assertTestSandbox guard
// refuses to touch env.configPath unless it's the sandboxed path — at the monorepo root it is the
// developer's REAL config.json (data-loss guard — see test_support/sandbox.ts). beforeEach runs first,
// so a root run throws before writeKeybinds → writeConfig can clobber it.
beforeEach(() => {
    assertTestSandbox(env.configPath);
    rmSync(env.configPath, { force: true });
    __resetKeybindCache();
});

afterEach(() => {
    assertTestSandbox(env.configPath);
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

    test("the plan-step command id is remappable", () => {
        writeKeybinds({ "plan.explore-steps": "ctrl+p" });
        expect(resolveKeybind("plan.explore-steps")).toEqual(parseChord("ctrl+p"));
        expect(keybindLabel("plan.explore-steps")).toBe("ctrl+p");
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

describe("run-activity panel bindings", () => {
    // The panel's two actions are ordinary remappable app keybindings — the point of this block is
    // that nothing about them is special-cased: they resolve, they relabel, and they remap like any
    // other, which is what lets the panel derive its displayed hints from the chords.
    test("both panel actions resolve to Ctrl chords — never Alt, which terminals deliver unreliably", () => {
        for (const id of ["app.run-panel-next", "app.run-panel-toggle"] as const) {
            const chord = resolveKeybind(id);
            expect(chord.ctrl).toBe(true);
            expect(chord.alt).toBe(false);
            // A bare printable would fire while the composer has focus; a modifier is what prevents it.
            expect(chord.key.length).toBe(1);
        }
    });

    test("the panel's labels are lowercase and derived, so a remap re-advertises itself", () => {
        expect(keybindLabel("app.run-panel-next")).toBe("ctrl+n");
        expect(keybindLabel("app.run-panel-toggle")).toBe("ctrl+r");

        writeKeybinds({ "app.run-panel-next": "ctrl+9", "app.run-panel-toggle": "ctrl+0" });
        // The panel renders exactly these strings — it never hand-writes a key beside an action.
        expect(keybindLabel("app.run-panel-next")).toBe("ctrl+9");
        expect(keybindLabel("app.run-panel-toggle")).toBe("ctrl+0");
    });

    test("the panel's chords collide with no other app binding", () => {
        // A collision would be silently arbitrated by layer priority rather than reported, so the
        // absence of one is worth pinning: every default app chord must be distinct.
        const labels = (Object.keys(KEYBIND_DEFAULTS) as (keyof typeof KEYBIND_DEFAULTS)[]).map((id) => keybindLabel(id));
        expect(new Set(labels).size).toBe(labels.length);
    });

    test("the panel's leader sequences document themselves in the which-key overlay", () => {
        withRoot(() => {
            // The overlay lists whatever the bindings declare — the desc/group are the documentation,
            // so a binding cannot exist without appearing there.
            useBindings(() => ({
                bindings: [
                    { chord: leaderSeq("p"), run: () => {}, desc: "Toggle run panel", group: "View" },
                    { chord: leaderSeq("]"), run: () => {}, desc: "Next active run", group: "View" },
                ],
            }));

            expect(dispatchKey(key("x", { ctrl: true }))).toBe(true); // the leader → pending
            const next = reachableKeys();
            const byStroke = new Map(next.map((n) => [n.stroke, n]));
            expect(byStroke.get("p")).toMatchObject({ desc: "Toggle run panel", group: "View" });
            expect(byStroke.get("]")).toMatchObject({ desc: "Next active run", group: "View" });
            dispatchKey(key("escape")); // abandon the pending sequence
        });
    });

    test("end-to-end: the panel chords dispatch centrally, and typing a bare letter does not", () => {
        withRoot(() => {
            let next = 0;
            let toggled = 0;
            useBindings(() => ({
                bindings: [
                    { chord: resolveKeybind("app.run-panel-next"), run: () => next++ },
                    { chord: resolveKeybind("app.run-panel-toggle"), run: () => toggled++ },
                ],
            }));

            expect(dispatchKey(key("n", { ctrl: true }))).toBe(true);
            expect(next).toBe(1);
            expect(dispatchKey(key("r", { ctrl: true }))).toBe(true);
            expect(toggled).toBe(1);

            // The composer's own keys are untouched: the unmodified letters fall through.
            expect(dispatchKey(key("n"))).toBe(false);
            expect(dispatchKey(key("r"))).toBe(false);
            expect(next).toBe(1);
            expect(toggled).toBe(1);
        });
    });
});
