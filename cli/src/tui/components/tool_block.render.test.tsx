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
        const frame = await frameWith(() => <ToolBlock name="grep" detail="src/x.ts" status="ok" durationMs={14} />, 60, 6, "grep");
        const nameRow = frame.split("\n")[rowOf(frame, "grep")];
        // The whole outcome (label + duration) folds onto the name line — nothing drops below it.
        expect(nameRow).toContain("grep");
        expect(nameRow).toContain("ok");
        expect(nameRow).toContain("14ms");
    });

    test("result form (result present): status sits on its own row below the panel", async () => {
        const frame = await frameWith(
            () => <ToolBlock name="read_file" detail="src/db.ts" result="RESULTBODY" filetype="text" status="ok" durationMs={14} />,
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
                () => <ToolBlock name="read_file" detail="src/some/really/long/path/that/should/wrap.ts" status="error" durationMs={320} />,
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

// The reflow is width-driven, so ONE fixture is swept across widths that produce each form — a single
// width would hide whichever form it does not happen to trigger. The property under test is that
// nothing is ever CUT: a workspace path's tail names the file, and the detail is one opaque harness
// string the block is not allowed to parse, so it cannot elide the middle intelligently.
const LONG_DETAIL = "runs/2026-07-30/step-2/output/summary.md";

describe("ToolBlock detail reflow", () => {
    test("wide terminal: a detail that fits rides the name line", async () => {
        const frame = await frameWith(() => <ToolBlock name="read_file" detail={LONG_DETAIL} status="ok" durationMs={14} />, 120, 6, "read_file");
        const nameRow = frame.split("\n")[rowOf(frame, "read_file")];
        expect(nameRow).toContain(LONG_DETAIL);
        expect(nameRow).toContain("ok");
        expect(nameRow).toContain("14ms");
    });

    test("narrower terminal: the same detail drops to its own row, whole", async () => {
        const frame = await frameWith(() => <ToolBlock name="read_file" detail={LONG_DETAIL} status="ok" durationMs={14} />, 100, 8, "read_file");
        const nameRowIdx = rowOf(frame, "read_file");
        expect(rowOf(frame, LONG_DETAIL)).toBeGreaterThan(nameRowIdx);
        // Only the detail moves. The status stays beside the name, which is what puts it in a
        // near-constant column across split blocks instead of floating behind a variable-length detail.
        expect(frame.split("\n")[nameRowIdx]).toContain("ok");
        expect(frame.split("\n")[nameRowIdx]).not.toContain(LONG_DETAIL);
    });

    // The sidebar-open chat column the spec mandates. The detail is wider than the indented row here,
    // so it soft-wraps INSIDE its own box across two rows. The property is that no character is lost:
    // a `toContain` on the whole string cannot express that, because the wrap splits it — so rejoin the
    // indented rows and compare. Truncation would fail this where a bare glyph check would not.
    test("width 40 (sidebar open): a wrapped detail loses no characters", async () => {
        const frame = await frameWith(() => <ToolBlock name="read_file" detail={LONG_DETAIL} status="ok" durationMs={14} />, 40, 10, "read_file");
        const rejoined = frame
            .split("\n")
            .filter((line) => line.startsWith("  ") && line.trim().length > 0)
            .map((line) => line.trim())
            .join("");
        expect(rejoined).toBe(LONG_DETAIL);
        expect(frame).not.toContain("…");
    });

    // Both subordinate rows carry their indent on a wrapping <box>, because opentui ignores padding on
    // a text renderable — the prop form renders flush against the gutter and silently stops reading as
    // subordinate. Nothing else catches that: the characters are all present either way.
    test("the reflowed detail and the activity row are both indented under the call", async () => {
        const frame = await frameWith(
            () => <ToolBlock name="read_file" detail={LONG_DETAIL} status="running" activity="planner: bash" />,
            100,
            10,
            "read_file",
        );
        const lines = frame.split("\n");
        expect(lines[rowOf(frame, LONG_DETAIL)]).toMatch(/^ {2}\S/);
        expect(lines[rowOf(frame, "planner: bash")]).toMatch(/^ {2}\S/);
        // The name line itself stays flush — the marker gutter is what the rows indent under.
        expect(lines[rowOf(frame, "read_file")]).toMatch(/^\S/);
    });

    test("a hookless tool with no detail renders exactly as before", async () => {
        const frame = await frameWith(() => <ToolBlock name="search_semantic_scholar" status="ok" durationMs={890} />, 120, 6, "search_semantic_scholar");
        const nameRow = frame.split("\n")[rowOf(frame, "search_semantic_scholar")];
        expect(nameRow).toContain("ok");
        expect(nameRow).toContain("890ms");
    });
});
