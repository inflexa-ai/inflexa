import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import { renderFrame } from "../../test_support/tui.ts";

import { RunBlock, type RunStepView } from "./run_block.tsx";

/** The rail's window size — the sidebar RUNS embed's `maxSteps`, mirrored so the cases track it. */
const RAIL_WINDOW = 7;

/** A run whose first `done` steps are complete, the next is running, and the rest are queued. */
function steps(total: number, done: number): RunStepView[] {
    return Array.from({ length: total }, (_, i) => ({
        label: `S${i + 1}`,
        state: i < done ? "done" : i === done ? "running" : "queued",
    }));
}

/** The rail mount the sidebar RUNS section uses: windowed, no heading, no detach/abort footer. */
function railBlock(total: number, done: number) {
    return () => (
        <RunBlock name="cohort-screen" tag="T9S2" done={done} total={total} steps={steps(total, done)} maxSteps={RAIL_WINDOW} hint={false} heading={false} />
    );
}

/** Whether step `n` has a row on screen. Word-bounded, so `S1` never matches the `S10`/`S12` rows. */
function hasStep(frame: string, n: number): boolean {
    return new RegExp(`\\bS${n}\\b`).test(frame);
}

/** Every step the frame accounts for: the rows it shows plus the counts its elision markers admit to hiding. */
function accountedFor(frame: string, total: number): number {
    const shown = Array.from({ length: total }, (_, i) => i + 1).filter((n) => hasStep(frame, n)).length;
    return shown + [...frame.matchAll(/(\d+) (?:earlier|more) steps?/g)].reduce((sum, m) => sum + Number(m[1]), 0);
}

/** Right-trim + drop trailing blanks, matching `renderFrame` so frame text and coordinates agree. */
function tidy(frame: string): string {
    return frame
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trimEnd();
}

/**
 * Render the rail mount live over a mutable run, and hand the caller a click driver, a frame reader and
 * a props updater. `update` always mints a FRESH props object even when the values are unchanged, which
 * is what the sidebar's poll does every few seconds — the distinction between "the ledger was re-read"
 * and "something actually changed" is exactly what the window's pin-and-release rules turn on, and a
 * harness that reused the object would let a broken release rule pass.
 */
async function withRail(
    initial: RunStepView[],
    body: (rail: {
        click: (arrow: "↑" | "↓") => Promise<void>;
        frame: () => string;
        update: (next: { steps?: RunStepView[]; tag?: string }) => Promise<void>;
    }) => Promise<void>,
) {
    const [run, setRun] = createSignal({ steps: initial, tag: "T9S2" });
    const doneCount = (xs: RunStepView[]): number => xs.filter((s) => s.state === "done").length;
    const setup = await testRender(
        () => (
            <RunBlock
                name="cohort-screen"
                tag={run().tag}
                done={doneCount(run().steps)}
                total={run().steps.length}
                steps={run().steps}
                maxSteps={RAIL_WINDOW}
                hint={false}
                heading={false}
            />
        ),
        { width: 40, height: 24 },
    );
    try {
        await setup.renderOnce();
        const frame = (): string => tidy(setup.captureCharFrame());
        const click = async (arrow: "↑" | "↓"): Promise<void> => {
            const lines = setup.captureCharFrame().split("\n");
            const y = lines.findIndex((line) => line.includes(arrow));
            if (y < 0) throw new Error(`no ${arrow} marker on screen:\n${frame()}`);
            await setup.mockMouse.click(lines[y]!.indexOf(arrow), y);
            await setup.renderOnce();
        };
        const update = async (next: { steps?: RunStepView[]; tag?: string }): Promise<void> => {
            // A fresh object every time, even when nothing changed — the poll's shape.
            setRun((prev) => ({ steps: next.steps ?? [...prev.steps], tag: next.tag ?? prev.tag }));
            await setup.renderOnce();
            await setup.renderOnce();
        };
        await body({ click, frame, update });
    } finally {
        setup.renderer.destroy();
    }
}

describe("RunBlock step window", () => {
    test("a run one step over the cap renders every step rather than hiding one behind a marker", async () => {
        // Eliding a single step to spend a row on its marker saves nothing, so the whole list renders.
        const frame = await renderFrame(railBlock(8, 4), { width: 40, height: 18 });
        for (let i = 1; i <= 8; i++) expect(hasStep(frame, i)).toBe(true);
        expect(frame).toContain("4/8");
        expect(frame).not.toContain("more step");
        expect(frame).not.toContain("earlier step");
    });

    test("a long run windows its steps and states both hidden counts", async () => {
        // 12 steps with the frontier at S8: the window centres on it (S5–S11), leaving 4 elided above
        // and 1 below — 9 rows for 12 steps, so the markers earn their place.
        const frame = await renderFrame(railBlock(12, 7), { width: 40, height: 18 });
        expect(frame).toContain("4 earlier steps");
        expect(frame).toContain("1 more step");
        expect(frame).toContain("7/12");
        expect(hasStep(frame, 8)).toBe(true);
        expect(hasStep(frame, 1)).toBe(false);
        expect(hasStep(frame, 12)).toBe(false);
    });

    test("an odd window puts the frontier on its exact middle row", async () => {
        // The centring promise: with room on both sides the running step sits at offset floor(7/2)=3,
        // the 4th of 7 rows, so equal context is visible before and after it.
        const frame = await renderFrame(railBlock(20, 10), { width: 40, height: 24 });
        const rows = frame.split("\n").filter((l) => /\bS\d+\b/.test(l));
        expect(rows).toHaveLength(RAIL_WINDOW);
        expect(rows[3]).toContain("S11"); // the running step (index 10)
    });

    test("the visible rows plus both hidden counts always account for every step", async () => {
        // The invariant the markers exist to uphold: nothing is silently dropped at any run length.
        for (const total of [7, 8, 9, 10, 12, 20, 31]) {
            const frame = await renderFrame(railBlock(total, Math.floor(total / 2)), { width: 40, height: 44 });
            expect({ total, accounted: accountedFor(frame, total) }).toEqual({ total, accounted: total });
        }
    });

    test("without maxSteps the whole list renders — the runs dialog's full view", async () => {
        const frame = await renderFrame(() => <RunBlock name="cohort-screen" tag="T9S2" done={7} total={12} steps={steps(12, 7)} hint={false} />, {
            width: 80,
            height: 24,
        });
        for (let i = 1; i <= 12; i++) expect(hasStep(frame, i)).toBe(true);
        expect(frame).not.toContain("more step");
    });
});

describe("RunBlock window scrolling", () => {
    // 20 steps with the frontier at S11: the window centres at start=7, leaving room to scroll both ways.
    test("clicking the up marker slides the window one step earlier", async () => {
        await withRail(steps(20, 10), async ({ click, frame }) => {
            expect(frame()).toContain("7 earlier steps");
            expect(hasStep(frame(), 7)).toBe(false);

            await click("↑");

            expect(frame()).toContain("6 earlier steps");
            expect(frame()).toContain("7 more steps");
            expect(hasStep(frame(), 7)).toBe(true);
            expect(hasStep(frame(), 14)).toBe(false);
        });
    });

    test("clicking the down marker slides the window one step later", async () => {
        await withRail(steps(20, 10), async ({ click, frame }) => {
            await click("↓");
            expect(frame()).toContain("8 earlier steps");
            expect(frame()).toContain("5 more steps");
            expect(hasStep(frame(), 15)).toBe(true);
            expect(hasStep(frame(), 8)).toBe(false);
        });
    });

    test("the window stops at the list ends and the exhausted marker disappears", async () => {
        await withRail(steps(20, 10), async ({ click, frame }) => {
            for (let i = 0; i < 7; i++) await click("↑");
            expect(frame()).not.toContain("earlier step");
            expect(frame()).toContain("13 more steps");
            expect(hasStep(frame(), 1)).toBe(true);
            await expect(click("↑")).rejects.toThrow("no ↑ marker");

            for (let i = 0; i < 13; i++) await click("↓");
            expect(frame()).not.toContain("more step");
            expect(frame()).toContain("13 earlier steps");
            expect(hasStep(frame(), 20)).toBe(true);
            await expect(click("↓")).rejects.toThrow("no ↓ marker");
        });
    });

    test("scrolling never loses a step — the accounting invariant holds at every position", async () => {
        await withRail(steps(20, 10), async ({ click, frame }) => {
            for (let i = 0; i < 7; i++) await click("↑");
            for (let position = 0; position <= 13; position++) {
                expect({ position, accounted: accountedFor(frame(), 20) }).toEqual({ position, accounted: 20 });
                if (frame().includes("↓")) await click("↓");
            }
        });
    });
});

describe("RunBlock window pinning", () => {
    test("a scrolled window survives a ledger poll that changed nothing", async () => {
        // The rail re-reads every few seconds and re-renders this block with a freshly-minted props
        // object. Only a real change may move the window; a bare refresh must leave the reader where
        // they are, or scrolling back through a long run is impossible on a live rail.
        await withRail(steps(20, 10), async ({ click, frame, update }) => {
            await click("↑");
            await click("↑");
            expect(frame()).toContain("5 earlier steps");

            await update({});
            await update({});

            expect(frame()).toContain("5 earlier steps");
        });
    });

    test("the window snaps back to the work when the active step advances", async () => {
        await withRail(steps(20, 10), async ({ click, frame, update }) => {
            for (let i = 0; i < 5; i++) await click("↑");
            expect(frame()).toContain("2 earlier steps");
            expect(hasStep(frame(), 11)).toBe(false); // the running step is scrolled out of view

            await update({ steps: steps(20, 11) });

            // Recentred on the new running step (S12, index 11) — start clamps to 11-3 = 8.
            expect(frame()).toContain("8 earlier steps");
            expect(hasStep(frame(), 12)).toBe(true);
            const rows = frame()
                .split("\n")
                .filter((l) => /\bS\d+\b/.test(l));
            expect(rows[3]).toContain("S12");
        });
    });

    test("a different run releases the pin instead of inheriting the previous run's position", async () => {
        // The sidebar's embed is non-keyed, so a run handover reuses this instance.
        await withRail(steps(20, 10), async ({ click, frame, update }) => {
            for (let i = 0; i < 4; i++) await click("↑");
            expect(frame()).toContain("3 earlier steps");

            await update({ tag: "OTHER1" });

            expect(frame()).toContain("7 earlier steps");
        });
    });
});

describe("RunBlock parallel steps", () => {
    /** Steps from an explicit state list, so a wave with several in flight can be spelled out. */
    function wave(states: RunStepView["state"][]): RunStepView[] {
        return states.map((state, i) => ({ label: `S${i + 1}`, state }));
    }

    /** A 20-step run with `running` at the given indices, everything before them done, the rest queued. */
    function parallel(running: number[]): RunStepView[] {
        const last = Math.max(...running);
        return wave(Array.from({ length: 20 }, (_, i) => (running.includes(i) ? "running" : i < last ? "done" : "queued")));
    }

    test("the window anchors on the EARLIEST running step, not the first not-done one", async () => {
        // Steps 8, 9 and 10 are in flight together. Centring on the earliest puts it on the middle row
        // with its siblings just below, so the whole wave is on screen at once.
        const frame = await renderFrame(
            () => <RunBlock name="r" tag="T1" done={8} total={20} steps={parallel([8, 9, 10])} maxSteps={RAIL_WINDOW} hint={false} heading={false} />,
            { width: 40, height: 24 },
        );
        const rows = frame.split("\n").filter((l) => /\bS\d+\b/.test(l));
        expect(rows[3]).toContain("S9"); // index 8, the earliest running step, dead centre
        for (const n of [9, 10, 11]) expect(hasStep(frame, n)).toBe(true);
    });

    test("a later parallel step finishing leaves the still-running earlier one on screen", async () => {
        // The reported shape: [done, running, running, done] → [done, running, done, done]. The step that
        // is STILL running must not be scrolled away just because its sibling finished — which is exactly
        // what anchoring on "first not-done" would have done once the sibling's row went done.
        await withRail(parallel([8, 9]), async ({ frame, update }) => {
            expect(hasStep(frame(), 9)).toBe(true);

            await update({ steps: parallel([8]) });

            expect(hasStep(frame(), 9)).toBe(true);
            const rows = frame()
                .split("\n")
                .filter((l) => /\bS\d+\b/.test(l));
            expect(rows[3]).toContain("S9");
        });
    });

    test("a change anywhere in the active set snaps a scrolled window back", async () => {
        // The anchor itself does not move here — only the sibling finishes — so a snap keyed on the
        // anchor alone would leave the reader stranded. The whole running set is the trigger.
        await withRail(parallel([8, 9]), async ({ click, frame, update }) => {
            for (let i = 0; i < 4; i++) await click("↑");
            expect(frame()).toContain("1 earlier step");
            expect(hasStep(frame(), 9)).toBe(false);

            await update({ steps: parallel([8]) });

            expect(frame()).toContain("5 earlier steps");
            expect(hasStep(frame(), 9)).toBe(true);
        });
    });
});

describe("RunBlock marker selection", () => {
    /**
     * Drag across the row holding `needle` and report what the renderer considers selected. The drag
     * STARTS on the needle's own column, not at x=0: the step list is a bordered, padded box, and a press
     * on the border or the padding lands on the box rather than the text — no selection begins at all,
     * which would make every assertion here pass for the wrong reason.
     */
    async function dragRow(setup: Awaited<ReturnType<typeof testRender>>, needle: string): Promise<string> {
        const lines = setup.captureCharFrame().split("\n");
        const y = lines.findIndex((line) => line.includes(needle));
        expect(y).toBeGreaterThanOrEqual(0);
        await setup.mockMouse.drag(lines[y]!.indexOf(needle), y, lines[y]!.trimEnd().length, y);
        await setup.renderOnce();
        return setup.renderer.getSelection()?.getSelectedText() ?? "";
    }

    test("the markers are controls, not prose — dragging over one selects nothing", async () => {
        const setup = await testRender(railBlock(20, 10), { width: 40, height: 24 });
        try {
            await setup.renderOnce();
            expect(await dragRow(setup, "earlier step")).not.toContain("earlier");
            expect(await dragRow(setup, "more step")).not.toContain("more");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("step rows stay selectable — the opt-out is scoped to the two controls", async () => {
        const setup = await testRender(railBlock(20, 10), { width: 40, height: 24 });
        try {
            await setup.renderOnce();
            expect(await dragRow(setup, "S11")).toContain("S11");
        } finally {
            setup.renderer.destroy();
        }
    });
});
