import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { ToolBlock } from "./tool_block.tsx";

// Frame coverage for the inline-vs-completion-line status placement. captureCharFrame gives characters
// only, which is all these assertions need: the invariant is WHICH ROW the status sits on, and (for the
// narrow case) that a soft-wrap keeps it on screen rather than dropping it.

/** Render `node` at `{width,height}`, driving frames until `needle` appears (the <code> panel parses async). */
async function frameWith(node: Parameters<typeof testRender>[0], width: number, height: number, needle: string, timeoutMs = 2500): Promise<string> {
    const setup = await testRender(node, { width, height });
    try {
        const start = Date.now();
        for (;;) {
            await setup.renderOnce();
            const f = setup.captureCharFrame();
            if (f.includes(needle) || Date.now() - start > timeoutMs) return f;
            await new Promise((r) => setTimeout(r, 10));
        }
    } finally {
        setup.renderer.destroy();
    }
}

/** Index of the first frame row containing `needle`, or -1. */
function rowOf(frame: string, needle: string): number {
    return frame.split("\n").findIndex((line) => line.includes(needle));
}

describe("ToolBlock status placement", () => {
    test("inline form (no result): name and status share one row", async () => {
        const frame = await frameWith(() => <ToolBlock name="grep" target="src/x.ts" status="ok" durationMs={14} />, 60, 6, "grep");
        const nameRow = frame.split("\n")[rowOf(frame, "grep")];
        // The whole outcome (label + duration) folds onto the name line — nothing drops below it.
        expect(nameRow).toContain("grep");
        expect(nameRow).toContain("ok");
        expect(nameRow).toContain("14ms");
    });

    test("result form (result present): status sits on its own row below the panel", async () => {
        const frame = await frameWith(
            () => <ToolBlock name="read_file" target="src/db.ts" result="RESULTBODY" filetype="text" status="ok" durationMs={14} />,
            60,
            12,
            "RESULTBODY",
        );
        const nameRow = rowOf(frame, "read_file");
        const bodyRow = rowOf(frame, "RESULTBODY");
        const statusRow = rowOf(frame, "ok");
        // The name row must NOT carry the outcome, and the completion line must fall BELOW the result panel.
        expect(frame.split("\n")[nameRow]).not.toContain("ok");
        expect(bodyRow).toBeGreaterThan(nameRow);
        expect(statusRow).toBeGreaterThan(bodyRow);
    });

    // The sidebar-open chat column is ~40 cols. An inline line longer than that must SOFT-WRAP (the reason
    // the status flows after the name instead of right-aligning), so the outcome survives on the next row
    // rather than being pushed off the edge. Sweep a couple of heights — the wrap is width-, not height-driven,
    // but a doubled/clipped row would only show at some heights.
    for (const height of [6, 8]) {
        test(`inline form at width 40, height ${height}: the status survives the soft-wrap`, async () => {
            const frame = await frameWith(
                () => <ToolBlock name="read_file" target="src/some/really/long/path/that/should/wrap.ts" status="error" durationMs={320} />,
                40,
                height,
                "read_file",
            );
            expect(frame).toContain("read_file");
            // Both the label and its duration made it onto the wrapped row — the line reflowed, it did not vanish.
            expect(frame).toContain("error");
            expect(frame).toContain("320ms");
        });
    }
});
