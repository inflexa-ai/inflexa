import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSignal, For } from "solid-js";
import { testRender } from "@opentui/solid";

import { ScrollPane } from "./scroll_pane.tsx";

// Regression sentinel for the opentui rendering contract FixedList relies on (see
// HORRIBLE_BUG_FIXES.md entry 1): Solid's `<For>` keys rows by reference, so when a filtered
// array shrinks and then grows back with the SAME item references, surviving nodes are reused
// and restored ones re-inserted via `insertBefore(node, existingAnchor)`. On @opentui/core
// 0.4.0 that anchor lookup failed inside the scrollbox content and the insert was silently
// skipped (warn + return -1) — rows vanished. 0.4.2 fixed it. This test exercises the reuse
// path through every shape the list primitives produce, so a future @opentui/* bump that
// regresses it fails loudly instead of silently dropping picker rows. Escape hatch if it ever
// reds out: switch FixedList to `<Index>` (position-keyed — never re-inserts before an anchor).
//
// Code that mints fresh wrapper objects per update never exercises this path (all-new refs →
// full teardown + append-only mounts), which is why a broken version can look fine in one list
// and broken in another — hence STABLE references throughout this file.

type It = { id: string };
const ALL: It[] = ["alpha", "bravo", "charlie", "delta", "echo"].map((id) => ({ id }));

// Capturing console.warn is the only observable channel for the skipped-insertBefore failure mode.
let warns: string[] = [];
const origWarn = console.warn;

beforeEach(() => {
    warns = [];
    console.warn = (...args: unknown[]) => {
        warns.push(args.map(String).join(" "));
    };
});

afterEach(() => {
    console.warn = origWarn;
});

function insertWarnings(): string[] {
    return warns.filter((w) => w.includes("insertBefore"));
}

/** Every listed id appears in the frame, and no unlisted member of ALL does. */
function expectExactly(frame: string, ids: string[]): void {
    for (const it of ALL) {
        if (ids.includes(it.id)) expect(frame).toContain(it.id);
        else expect(frame).not.toContain(it.id);
    }
}

describe("For inside a scrollbox reuses rows correctly (FixedList's rendering contract)", () => {
    test("shrink then grow with stable references restores every row", async () => {
        const [items, setItems] = createSignal<It[]>(ALL);
        const setup = await testRender(
            () => (
                <ScrollPane focusOnMount={false} width="100%" flexGrow={1}>
                    <For each={items()}>{(it) => <text>{it.id}</text>}</For>
                </ScrollPane>
            ),
            { width: 30, height: 10 },
        );
        try {
            await setup.renderOnce();
            expectExactly(setup.captureCharFrame(), ["alpha", "bravo", "charlie", "delta", "echo"]);

            setItems([ALL[1]!]); // same object reference — the reuse path, not a rebuild
            await setup.renderOnce();
            expectExactly(setup.captureCharFrame(), ["bravo"]);

            setItems(ALL); // restored rows are re-inserted BEFORE the surviving anchor
            await setup.renderOnce();
            await setup.renderOnce();
            expectExactly(setup.captureCharFrame(), ["alpha", "bravo", "charlie", "delta", "echo"]);
            expect(insertWarnings()).toEqual([]);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("reordered subsets and full-set scrambles keep every row", async () => {
        const [items, setItems] = createSignal<It[]>(ALL);
        const setup = await testRender(
            () => (
                <ScrollPane focusOnMount={false} width="100%" flexGrow={1}>
                    <For each={items()}>{(it) => <text>{it.id}</text>}</For>
                </ScrollPane>
            ),
            { width: 30, height: 10 },
        );
        try {
            await setup.renderOnce();

            setItems([ALL[3]!, ALL[1]!]); // subset AND reordered — rankBy's shape
            await setup.renderOnce();
            expectExactly(setup.captureCharFrame(), ["delta", "bravo"]);

            setItems([ALL[4]!, ALL[2]!, ALL[0]!, ALL[1]!, ALL[3]!]); // full set, scrambled
            await setup.renderOnce();
            expectExactly(setup.captureCharFrame(), ["alpha", "bravo", "charlie", "delta", "echo"]);

            setItems(ALL); // back to original order — pure moves of existing nodes
            await setup.renderOnce();
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            expectExactly(frame, ["alpha", "bravo", "charlie", "delta", "echo"]);
            // Order is part of the contract: a move that lands wrong is as broken as a drop.
            expect(frame.indexOf("alpha")).toBeLessThan(frame.indexOf("bravo"));
            expect(frame.indexOf("delta")).toBeLessThan(frame.indexOf("echo"));
            expect(insertWarnings()).toEqual([]);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("grouped tuples with fragment children and nested For survive shrink-then-grow", async () => {
        // The grouped [category, items[]][] projection the list core derives: tuples are minted
        // fresh per update while the leaf items keep stable references — both keying behaviors
        // exercised in one tree.
        const groupsOf = (its: It[]): [string, It[]][] => {
            const m = new Map<string, It[]>();
            for (const it of its) {
                const cat = it.id < "d" ? "early" : "late";
                const arr = m.get(cat);
                if (arr) arr.push(it);
                else m.set(cat, [it]);
            }
            return [...m.entries()];
        };
        const [items, setItems] = createSignal<It[]>(ALL);
        const setup = await testRender(
            () => (
                <ScrollPane focusOnMount={false} width="100%" flexGrow={1}>
                    <For each={groupsOf(items())}>
                        {([cat, its]) => (
                            <>
                                <text>[{cat}]</text>
                                <For each={its}>{(it) => <text>- {it.id}</text>}</For>
                            </>
                        )}
                    </For>
                </ScrollPane>
            ),
            { width: 30, height: 12 },
        );
        try {
            await setup.renderOnce();
            expectExactly(setup.captureCharFrame(), ["alpha", "bravo", "charlie", "delta", "echo"]);

            setItems([ALL[4]!]); // only "echo" → the "early" group disappears entirely
            await setup.renderOnce();
            const shrunk = setup.captureCharFrame();
            expectExactly(shrunk, ["echo"]);
            expect(shrunk).toContain("[late]");
            expect(shrunk).not.toContain("[early]");

            setItems(ALL);
            await setup.renderOnce();
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            expectExactly(frame, ["alpha", "bravo", "charlie", "delta", "echo"]);
            expect(frame).toContain("[early]");
            expect(frame).toContain("[late]");
            expect(insertWarnings()).toEqual([]);
        } finally {
            setup.renderer.destroy();
        }
    });
});
