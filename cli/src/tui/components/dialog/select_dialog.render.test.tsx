import { afterEach, describe, expect, test } from "bun:test";
import type { JSX } from "solid-js";
import { testRender } from "@opentui/solid";

import { GLYPHS } from "../../../lib/design_system.ts";
import { useKeymapRoot } from "../../keymap.ts";
import { DialogOverlay, dialogClear, dialogPush } from "./dialog_host.tsx";
import { SelectDialog } from "./select_dialog.tsx";
import type { SelectItem } from "../list_core.tsx";

// SelectDialog forwards `initialValue` and `onCursorChange` to its FixedList and does nothing else with
// them — but "forwards" is only observable through a render, because the list is an implementation
// detail of the dialog. Driven through the REAL dialog host and keyboard bus (the model-picker render
// test's harness) so the filter input owns focus exactly as it does in production, which is what makes
// the typed-query case meaningful.

const FRUIT: SelectItem<string>[] = [
    { value: "apple", title: "apple" },
    { value: "banana", title: "banana" },
    { value: "carrot", title: "carrot" },
];

function Harness(): JSX.Element {
    useKeymapRoot();
    return (
        <box width="100%" height="100%">
            <DialogOverlay />
        </box>
    );
}

type Setup = Awaited<ReturnType<typeof testRender>>;

// A real-clock settle: the dialog host applies initial focus on a microtask and the list's seeded
// scroll retries on a macrotask, so a pure render pair is too early for both.
async function settle(setup: Setup): Promise<string> {
    await new Promise((r) => setTimeout(r, 20));
    await setup.renderOnce();
    await setup.renderOnce();
    return setup.captureCharFrame();
}

describe("SelectDialog cursor seams", () => {
    afterEach(() => {
        dialogClear();
    });

    test("opens on the seeded row, reports moves, and reports undefined once the filter empties the list", async () => {
        const reported: (string | undefined)[] = [];
        const setup = await testRender(() => <Harness />, { width: 80, height: 24 });
        try {
            await settle(setup);
            dialogPush(() => (
                <SelectDialog
                    title="Pick a fruit"
                    items={FRUIT}
                    emptyText="No fruit"
                    initialValue="carrot"
                    onCursorChange={(v) => reported.push(v)}
                    onCancel={() => {}}
                />
            ));
            let frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} carrot`);
            // The FIRST report is the seeded row — a host previewing the highlighted row must never see
            // row 0 flash by on open.
            expect(reported[0]).toBe("carrot");

            setup.mockInput.pressArrow("up");
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} banana`);
            expect(reported.at(-1)).toBe("banana");

            // Typing goes to the focused filter input; the list's cursor follows to the best match.
            await setup.mockInput.typeText("app");
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} apple`);
            expect(reported.at(-1)).toBe("apple");

            await setup.mockInput.typeText("zzz"); // "appzzz" matches nothing
            frame = await settle(setup);
            expect(frame).toContain("No fruit");
            expect(reported.at(-1)).toBeUndefined();
        } finally {
            setup.renderer.destroy();
        }
    });

    test("without the seams the dialog behaves as before: cursor on row 0, no callback required", async () => {
        const setup = await testRender(() => <Harness />, { width: 80, height: 24 });
        try {
            await settle(setup);
            dialogPush(() => <SelectDialog title="Pick a fruit" items={FRUIT} emptyText="No fruit" onCancel={() => {}} />);
            const frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.chevronRight} apple`);
        } finally {
            setup.renderer.destroy();
        }
    });
});
