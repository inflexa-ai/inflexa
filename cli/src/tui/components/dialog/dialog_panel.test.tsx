import { describe, expect, test } from "bun:test";

import { renderFrame } from "../../../test_support/tui.ts";
import { DialogPanel } from "./dialog_panel.tsx";

// Renders the dialog chrome headlessly across a short and a tall terminal: the title (drawn in the
// border), the body, and the footer must all survive at both sizes. Sweeping heights is the guard
// against the size-dependent layout artifacts CLAUDE.md documents (a single size hides them).
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
});
