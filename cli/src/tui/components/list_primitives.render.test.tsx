import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { testRender } from "@opentui/solid";

import { useKeymapRoot } from "../keymap.ts";
import { FixedList } from "./fixed_list.tsx";
import { DynamicList } from "./dynamic_list.tsx";
import { GLYPHS } from "../../lib/design_system.ts";
import type { SelectItem } from "./list_core.tsx";

// Behavior tests for the list primitives through the real keyboard bus. The lists register
// their layer via useDialogBindings; outside any dialog that gates on !dialogIsOpen(), which is
// always true here — so a bare keymap root is the whole harness.

function Harness(props: { children: JSX.Element }): JSX.Element {
    useKeymapRoot();
    return (
        <box width="100%" height="100%">
            {props.children}
        </box>
    );
}

const FRUIT: SelectItem<string>[] = [
    { value: "apple", title: "apple", category: "fruit" },
    { value: "banana", title: "banana", category: "fruit" },
    { value: "carrot", title: "carrot", category: "veg" },
    { value: "daikon", title: "daikon", category: "veg" },
];

type Setup = Awaited<ReturnType<typeof testRender>>;

async function settle(setup: Setup): Promise<string> {
    await setup.renderOnce();
    await setup.renderOnce();
    return setup.captureCharFrame();
}

describe("filtering", () => {
    test("category headers survive filtering (FixedList)", async () => {
        const [query, setQuery] = createSignal("");
        const setup = await testRender(
            () => (
                <Harness>
                    <FixedList items={FRUIT} query={query()} emptyText="none" />
                </Harness>
            ),
            { width: 40, height: 14 },
        );
        try {
            let frame = await settle(setup);
            expect(frame).toContain("fruit");
            expect(frame).toContain("veg");
            expect(frame).toContain("apple");
            expect(frame).toContain("daikon");

            setQuery("dai"); // only daikon survives — its veg header must too
            frame = await settle(setup);
            expect(frame).toContain("veg");
            expect(frame).toContain("daikon");
            expect(frame).not.toContain("fruit");
            expect(frame).not.toContain("apple");

            setQuery(""); // everything (and both headers) restored — the For reuse path
            frame = await settle(setup);
            expect(frame).toContain("fruit");
            expect(frame).toContain("apple");
            expect(frame).toContain("banana");
            expect(frame).toContain("carrot");
            expect(frame).toContain("daikon");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("empty state renders emptyText; errorText substitutes", async () => {
        const [err, setErr] = createSignal<string | null>(null);
        const setup = await testRender(
            () => (
                <Harness>
                    <DynamicList items={[]} errorText={err()} emptyText="nothing here" />
                </Harness>
            ),
            { width: 40, height: 8 },
        );
        try {
            expect(await settle(setup)).toContain("nothing here");
            setErr("boom: unreadable");
            expect(await settle(setup)).toContain("boom: unreadable");
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("cursor and navigation", () => {
    test("down moves the chevron; cursor clamps when the set shrinks", async () => {
        const [query, setQuery] = createSignal("");
        const setup = await testRender(
            () => (
                <Harness>
                    <FixedList items={FRUIT} query={query()} emptyText="none" />
                </Harness>
            ),
            { width: 40, height: 14 },
        );
        try {
            let frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} apple`);

            setup.mockInput.pressArrow("down");
            setup.mockInput.pressArrow("down");
            setup.mockInput.pressArrow("down");
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} daikon`);

            // Two rows survive; the cursor (was 3) clamps onto the last of them. Both are
            // "a"-matches; apple ranks first (earlier first hit), banana second.
            setQuery("an");
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} banana`);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("ctrl+p/ctrl+n move; a new query resets the cursor; ctrl+p on the first row wraps to the last", async () => {
        const [query, setQuery] = createSignal("");
        const setup = await testRender(
            () => (
                <Harness>
                    <FixedList items={FRUIT} query={query()} emptyText="none" />
                </Harness>
            ),
            { width: 40, height: 14 },
        );
        try {
            setup.mockInput.pressKey("n", { ctrl: true });
            let frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} banana`);

            setQuery("carrot");
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} carrot`);

            setQuery("");
            setup.mockInput.pressKey("p", { ctrl: true });
            frame = await settle(setup);
            // Query reset put the cursor at row 0; ctrl+p wraps up to the last row (daikon).
            expect(frame).toContain(`${GLYPHS.chevronRight} daikon`);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("rows beyond the viewport scroll into view as the cursor moves", async () => {
        const many: SelectItem<number>[] = Array.from({ length: 30 }, (_, i) => ({ value: i, title: `row-${String(i).padStart(2, "0")}` }));
        const setup = await testRender(
            () => (
                <Harness>
                    <box width="100%" height={8}>
                        <FixedList items={many} emptyText="none" />
                    </box>
                </Harness>
            ),
            { width: 40, height: 8 },
        );
        try {
            let frame = await settle(setup);
            expect(frame).toContain("row-00");
            expect(frame).not.toContain("row-29");

            for (let i = 0; i < 29; i++) setup.mockInput.pressArrow("down");
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} row-29`);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("FixedList wraps: down off the last row returns to the first", async () => {
        const setup = await testRender(
            () => (
                <Harness>
                    <FixedList items={FRUIT} emptyText="none" />
                </Harness>
            ),
            { width: 40, height: 14 },
        );
        try {
            let frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} apple`);

            setup.mockInput.pressKey("g", { shift: true }); // G → daikon (last row)
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} daikon`);

            setup.mockInput.pressArrow("down"); // one past the end wraps to the top
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} apple`);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("FixedList wraps: up off the first row lands on the last and scrolls it into view", async () => {
        const many: SelectItem<number>[] = Array.from({ length: 30 }, (_, i) => ({ value: i, title: `row-${String(i).padStart(2, "0")}` }));
        const setup = await testRender(
            () => (
                <Harness>
                    <box width="100%" height={8}>
                        <FixedList items={many} emptyText="none" />
                    </box>
                </Harness>
            ),
            { width: 40, height: 8 },
        );
        try {
            let frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} row-00`);
            expect(frame).not.toContain("row-29");

            setup.mockInput.pressArrow("up"); // wraps from the top to the last row, off-screen until now
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} row-29`);
            expect(frame).not.toContain("row-00");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("FixedList: a single-row list keeps the cursor put on up/down (wrap is a no-op)", async () => {
        const one: SelectItem<string>[] = [{ value: "solo", title: "solo" }];
        const setup = await testRender(
            () => (
                <Harness>
                    <FixedList items={one} emptyText="none" />
                </Harness>
            ),
            { width: 40, height: 8 },
        );
        try {
            let frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} solo`);

            setup.mockInput.pressArrow("down");
            setup.mockInput.pressArrow("up");
            setup.mockInput.pressKey("j");
            setup.mockInput.pressKey("k");
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} solo`);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("DynamicList clamps at the ends (no wrap): up on the first stays put, down on the last stays put", async () => {
        const setup = await testRender(
            () => (
                <Harness>
                    <DynamicList items={FRUIT} emptyText="none" />
                </Harness>
            ),
            { width: 40, height: 14 },
        );
        try {
            let frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} apple`);

            setup.mockInput.pressArrow("up"); // first row: clamps, does not wrap to the bottom
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} apple`);

            setup.mockInput.pressKey("g", { shift: true }); // G → daikon (last row)
            setup.mockInput.pressArrow("down"); // last row: clamps, does not wrap to the top
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} daikon`);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("FixedList: page keys clamp at the ends and never wrap", async () => {
        const setup = await testRender(
            () => (
                <Harness>
                    <FixedList items={FRUIT} emptyText="none" />
                </Harness>
            ),
            { width: 40, height: 14 },
        );
        try {
            let frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} apple`);

            // A page jump larger than the list clamps to the last row instead of wrapping...
            await setup.mockInput.pressKeys(["\x1b[6~"]); // pageDown
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} daikon`);

            // ...and paging back up clamps to the first row, never past it.
            await setup.mockInput.pressKeys(["\x1b[5~"]); // pageUp
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} apple`);
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("selection and submit", () => {
    test("single mode: enter selects-and-submits the cursor row", async () => {
        const picked: string[] = [];
        const setup = await testRender(
            () => (
                <Harness>
                    <FixedList items={FRUIT} emptyText="none" onSelect={(v) => picked.push(v)} />
                </Harness>
            ),
            { width: 40, height: 14 },
        );
        try {
            await settle(setup);
            setup.mockInput.pressArrow("down");
            setup.mockInput.pressEnter();
            await settle(setup);
            expect(picked).toEqual(["banana"]);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("multi mode: seed renders ●, space toggles, enter confirms the batch", async () => {
        const confirmed: string[][] = [];
        const changes: ReadonlySet<string>[] = [];
        const setup = await testRender(
            () => (
                <Harness>
                    <FixedList
                        items={FRUIT}
                        emptyText="none"
                        mode="multi"
                        initialSelected={new Set(["carrot"])}
                        onConfirm={(vs) => confirmed.push(vs)}
                        onSelectionChange={(s) => changes.push(s)}
                    />
                </Harness>
            ),
            { width: 40, height: 14 },
        );
        try {
            let frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.circle} carrot`);
            expect(frame).toContain(`${GLYPHS.circleHollow} apple`);
            expect(frame).not.toContain(GLYPHS.chevronRight); // no chevron in multi mode

            setup.mockInput.pressKey(" "); // toggle apple (cursor row 0)
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.circle} apple`);
            expect(changes.length).toBe(1);

            setup.mockInput.pressEnter();
            await settle(setup);
            expect(confirmed.length).toBe(1);
            expect(confirmed[0]!.sort()).toEqual(["apple", "carrot"]);

            setup.mockInput.pressKey(" "); // toggle apple back off
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.circleHollow} apple`);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("multi mode: enter confirms the batch even when no rows survive the filter", async () => {
        const confirmed: string[][] = [];
        const [query, setQuery] = createSignal("");
        const setup = await testRender(
            () => (
                <Harness>
                    <FixedList
                        items={FRUIT}
                        query={query()}
                        emptyText="none"
                        mode="multi"
                        initialSelected={new Set(["carrot"])}
                        onConfirm={(vs) => confirmed.push(vs)}
                    />
                </Harness>
            ),
            { width: 40, height: 14 },
        );
        try {
            setQuery("zzz"); // nothing matches — the accumulated batch must still hand back
            const frame = await settle(setup);
            expect(frame).toContain("none");

            setup.mockInput.pressEnter();
            await settle(setup);
            expect(confirmed).toEqual([["carrot"]]);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("multi mode: a canToggle-refused row renders no gutter", async () => {
        const setup = await testRender(
            () => (
                <Harness>
                    <FixedList items={FRUIT} emptyText="none" mode="multi" initialSelected={new Set(["apple"])} canToggle={(v) => v !== "apple"} />
                </Harness>
            ),
            { width: 40, height: 14 },
        );
        try {
            // apple is IN the selection but not toggleable here (the `..` shape: a value that
            // doubles as something else) — painting ● on it would advertise a lie.
            const frame = await settle(setup);
            expect(frame).not.toContain(`${GLYPHS.circle} apple`);
            expect(frame).not.toContain(`${GLYPHS.circleHollow} apple`);
            expect(frame).toContain(`${GLYPHS.circleHollow} banana`);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("onAction intercepts enter in both modes", async () => {
        const picked: string[] = [];
        const actions: string[] = [];
        const setup = await testRender(
            () => (
                <Harness>
                    <FixedList
                        items={FRUIT}
                        emptyText="none"
                        onSelect={(v) => picked.push(v)}
                        onAction={(v) => {
                            actions.push(v);
                            return v === "apple"; // intercept apple only
                        }}
                    />
                </Harness>
            ),
            { width: 40, height: 14 },
        );
        try {
            await settle(setup);
            setup.mockInput.pressEnter(); // apple — intercepted
            await settle(setup);
            expect(actions).toEqual(["apple"]);
            expect(picked).toEqual([]);

            setup.mockInput.pressArrow("down");
            setup.mockInput.pressEnter(); // banana — not intercepted
            await settle(setup);
            expect(picked).toEqual(["banana"]);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("enabled gates every list key; bareKeysEnabled gates space and vim keys alone", async () => {
        const picked: string[] = [];
        const changes: ReadonlySet<string>[] = [];
        const [enabled, setEnabled] = createSignal(false);
        const [bareKeysEnabled, setBareKeysEnabled] = createSignal(false);
        const setup = await testRender(
            () => (
                <Harness>
                    <FixedList
                        items={FRUIT}
                        emptyText="none"
                        mode="multi"
                        enabled={enabled()}
                        bareKeysEnabled={bareKeysEnabled()}
                        onConfirm={(vs) => picked.push(...vs)}
                        onSelectionChange={(s) => changes.push(s)}
                    />
                </Harness>
            ),
            { width: 40, height: 14 },
        );
        try {
            let frame = await settle(setup);
            setup.mockInput.pressArrow("down");
            setup.mockInput.pressKey(" ");
            setup.mockInput.pressEnter();
            frame = await settle(setup);
            expect(frame).not.toContain(GLYPHS.circle + " "); // nothing toggled...
            expect(changes.length).toBe(0);
            expect(picked.length).toBe(0); // ...and nothing confirmed

            setEnabled(true); // layer live, bare keys still gated
            setup.mockInput.pressKey(" ");
            setup.mockInput.pressKey("j");
            await settle(setup);
            expect(changes.length).toBe(0);

            setBareKeysEnabled(true);
            setup.mockInput.pressKey(" ");
            frame = await settle(setup);
            expect(changes.length).toBe(1);
            expect(frame).toContain(`${GLYPHS.circle} apple`);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("vim keys: j/k move the cursor, G jumps to the last row, gg back to the first", async () => {
        const setup = await testRender(
            () => (
                <Harness>
                    <FixedList items={FRUIT} emptyText="none" />
                </Harness>
            ),
            { width: 40, height: 14 },
        );
        try {
            let frame = await settle(setup);
            setup.mockInput.pressKey("j");
            setup.mockInput.pressKey("j");
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} carrot`);

            setup.mockInput.pressKey("k");
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} banana`);

            setup.mockInput.pressKey("g", { shift: true });
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} daikon`);

            setup.mockInput.pressKey("g");
            setup.mockInput.pressKey("g");
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} apple`);
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("items contracts", () => {
    test("FixedList: replacing the items array after mount is inert", async () => {
        const [items, setItems] = createSignal<SelectItem<string>[]>(FRUIT);
        const setup = await testRender(
            () => (
                <Harness>
                    <FixedList items={items()} emptyText="none" />
                </Harness>
            ),
            { width: 40, height: 14 },
        );
        try {
            let frame = await settle(setup);
            expect(frame).toContain("apple");

            setItems([{ value: "x", title: "zucchini" }]);
            frame = await settle(setup);
            expect(frame).toContain("apple"); // still the mount-time rows
            expect(frame).not.toContain("zucchini");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("DynamicList: replacing items updates rows in place", async () => {
        const [items, setItems] = createSignal<SelectItem<string>[]>(FRUIT);
        const setup = await testRender(
            () => (
                <Harness>
                    <DynamicList items={items()} emptyText="none" />
                </Harness>
            ),
            { width: 40, height: 14 },
        );
        try {
            let frame = await settle(setup);
            expect(frame).toContain("apple");

            // Fresh objects — the DynamicList source shape (e.g. a re-listed directory).
            setItems([
                { value: "e", title: "endive", category: "veg" },
                { value: "f", title: "fig", category: "fruit" },
            ]);
            frame = await settle(setup);
            expect(frame).toContain("endive");
            expect(frame).toContain("fig");
            expect(frame).not.toContain("apple");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("description of the cursor row renders as the detail line", async () => {
        const items: SelectItem<string>[] = [
            { value: "a", title: "alpha", description: "first letter" },
            { value: "b", title: "beta", description: "second letter" },
        ];
        const setup = await testRender(
            () => (
                <Harness>
                    <FixedList items={items} emptyText="none" />
                </Harness>
            ),
            { width: 40, height: 10 },
        );
        try {
            let frame = await settle(setup);
            expect(frame).toContain("first letter");
            setup.mockInput.pressArrow("down");
            frame = await settle(setup);
            expect(frame).toContain("second letter");
            expect(frame).not.toContain("first letter");
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("two-line meta rows", () => {
    test("meta renders left-aligned (under the title) on its own line beneath the title; an inline hint is suppressed when meta is present", async () => {
        const items: SelectItem<string>[] = [
            // A long title (wraps) plus a left-aligned meta line, and a hint that must NOT show —
            // meta owns the second line, so an inline hint would double up and is dropped.
            { value: "r1", title: "Clinical & mutation associations e4fc84", meta: "58a37a · completed · 7/13", hint: "SUPPRESSED" },
        ];
        const setup = await testRender(
            () => (
                <Harness>
                    <FixedList items={items} emptyText="none" />
                </Harness>
            ),
            { width: 40, height: 8 },
        );
        try {
            const frame = await settle(setup);
            const lines = frame.split("\n");
            const titleLine = lines.find((l) => l.includes("Clinical")) ?? "";
            const metaLine = lines.find((l) => l.includes("58a37a")) ?? "";
            // Two-line layout: title and meta occupy DIFFERENT rows, never the same line.
            expect(titleLine).not.toContain("58a37a");
            expect(metaLine).not.toContain("Clinical");
            // Left-aligned under the title: the meta begins near the left (a 2-col indent under the
            // title text), NOT pushed to the right edge — assert only a small leading gap precedes it.
            expect(metaLine).toMatch(/^\s{0,4}58a37a · completed · 7\/13/);
            // The inline hint is suppressed while meta is present.
            expect(frame).not.toContain("SUPPRESSED");
        } finally {
            setup.renderer.destroy();
        }
    });
});
