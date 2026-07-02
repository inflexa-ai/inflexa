import { describe, expect, test } from "bun:test";

import { renderFrame } from "../../../test_support/tui.ts";
import { DialogPanel } from "./dialog_panel.tsx";
import { ResultsDialog } from "./results_dialog.tsx";
import { SelectDialog } from "./select_dialog.tsx";

// Renders the dialog chrome headlessly across terminal sizes. Sweeping sizes is the guard against
// the size-dependent layout artifacts CLAUDE.md documents (a single size hides them). The sizing
// contract under test: fixed column widths clamped by maxWidth, content-driven height under
// maxHeight for md/lg (only xl fixes its height).
describe("DialogPanel", () => {
    test("renders title, body, and footer at multiple terminal heights", async () => {
        for (const height of [8, 16]) {
            const frame = await renderFrame(
                () => (
                    <DialogPanel title="My Dialog" size="xl" footer="esc cancel">
                        <text>Body content</text>
                    </DialogPanel>
                ),
                { width: 40, height },
            );
            expect(frame).toContain("My Dialog");
            expect(frame).toContain("Body content");
            expect(frame).toContain("esc cancel");
        }
    });

    test("width is fixed columns on wide terminals, clamped by maxWidth on narrow ones", async () => {
        const panel = () => (
            <DialogPanel title="T" size="lg" footer="f">
                <text>b</text>
            </DialogPanel>
        );
        // Wide terminal: lg renders at its fixed 88 columns, NOT a fraction of the 200 available.
        const wide = await renderFrame(panel, { width: 200, height: 20 });
        const wideCols = Math.max(...wide.split("\n").map((l) => l.length));
        expect(wideCols).toBe(88);
        // Narrow terminal: the fixed width would overflow, so the 90% clamp takes over (36 of 40).
        const narrow = await renderFrame(panel, { width: 40, height: 20 });
        const narrowCols = Math.max(...narrow.split("\n").map((l) => l.length));
        expect(narrowCols).toBe(36);
    });

    test("md is content-height: a short body yields a short panel, not a fixed-height box", async () => {
        const frame = await renderFrame(
            () => (
                <DialogPanel title="T" size="md">
                    <text>one</text>
                    <text>two</text>
                </DialogPanel>
            ),
            { width: 100, height: 40 },
        );
        // 2 border rows + 2 body rows; anything near a fixed tier height is a regression.
        expect(frame.split("\n").length).toBeLessThanOrEqual(5);
    });

    test("lg holds its fixed height, clamped by maxHeight on short terminals", async () => {
        const panel = () => (
            <DialogPanel title="T" size="lg" footer="f">
                <text>b</text>
            </DialogPanel>
        );
        const tall = await renderFrame(panel, { width: 100, height: 40 });
        expect(tall.split("\n").length).toBe(20);
        const short = await renderFrame(panel, { width: 100, height: 15 });
        expect(short.split("\n").length).toBeLessThanOrEqual(12);
    });
});

// The lg consumers hold the tier's FIXED height: a dialog that resizes as its content changes
// (the palette filtering down to three matches) is worse UX than trailing empty rows, so the
// panel must be the same height for one row as for fifty.
describe("lg consumers hold a stable height", () => {
    const LINES = Array.from({ length: 50 }, (_, i) => `line ${i}`);

    test("ResultsDialog is the same height for 1 line and 50 lines, and scrolls the overflow", async () => {
        const render = (lines: string[]) =>
            renderFrame(() => <ResultsDialog title="Results" lines={lines} emptyText="none" onClose={() => {}} />, { width: 100, height: 40 });
        const many = await render(LINES);
        const one = await render(["only line"]);
        expect(many.split("\n").length).toBe(20);
        expect(one.split("\n").length).toBe(20);
        expect(many).toContain("line 0");
        expect(one).toContain("only line");
        expect(many).toContain("close");
    });

    test("SelectDialog is the same height as filtering shrinks the row set", async () => {
        const items = Array.from({ length: 30 }, (_, i) => ({ value: i, title: `item ${i}` }));
        const render = (subset: typeof items) =>
            renderFrame(() => <SelectDialog title="Pick" items={subset} emptyText="none" onSelect={() => {}} onCancel={() => {}} />, {
                width: 100,
                height: 40,
            });
        const full = await render(items);
        const filtered = await render(items.slice(0, 2));
        expect(full.split("\n").length).toBe(20);
        expect(filtered.split("\n").length).toBe(20);
        expect(filtered).toContain("item 0");
        expect(full).toContain("select");
    });

    test("SelectDialog stays usable on a short terminal (clamped, chrome intact)", async () => {
        const items = Array.from({ length: 30 }, (_, i) => ({ value: i, title: `item ${i}` }));
        const frame = await renderFrame(() => <SelectDialog title="Pick" items={items} emptyText="none" onSelect={() => {}} onCancel={() => {}} />, {
            width: 100,
            height: 12,
        });
        expect(frame).toContain("Pick");
        expect(frame).toContain("item 0");
        expect(frame).toContain("select");
        expect(frame.split("\n").length).toBeLessThanOrEqual(10);
    });
});
