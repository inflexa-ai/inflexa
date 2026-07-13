import { describe, expect, test } from "bun:test";

import { renderFrame } from "../../test_support/tui.ts";
import { OpenableCardBlock, type OpenableRowView } from "./openable_card_block.tsx";

// Openable cards render synchronous text (no async markdown), so a single frame per size is enough.
// Sweep heights because opentui's yoga quirks (flexShrink / scrollbox overlap) are size-dependent.
const noop = (): void => {};

function chartRow(): OpenableRowView {
    return { icon: "chart", name: "Volcano plot", path: "/cache/pres-1.html", degraded: false };
}

describe("OpenableCardBlock layout", () => {
    for (const height of [6, 12, 24]) {
        test(`title, entry name, and resolved path all render at height ${height}`, async () => {
            const frame = await renderFrame(() => <OpenableCardBlock title="Volcano plot" rows={[chartRow()]} onOpen={noop} />, { width: 64, height });
            expect(frame).toContain("Volcano plot");
            expect(frame).toContain("/cache/pres-1.html");
        });
    }

    test("a degraded entry renders (missing/failed) without crashing", async () => {
        const frame = await renderFrame(
            () => (
                <OpenableCardBlock
                    rows={[{ icon: "report", name: "Report preview v2 failed", caption: "render timed out", path: null, degraded: true }]}
                    onOpen={noop}
                />
            ),
            { width: 64, height: 8 },
        );
        expect(frame).toContain("Report preview v2 failed");
        expect(frame).toContain("render timed out");
    });

    test("a multi-file gallery shows every row plus the folder affordance", async () => {
        const rows: OpenableRowView[] = [
            { icon: "image", name: "volcano.png", path: "/ws/figures/volcano.png", degraded: false },
            { icon: "image", name: "heatmap.png", path: "/ws/figures/heatmap.png", degraded: false },
        ];
        const frame = await renderFrame(
            () => <OpenableCardBlock title="Figures" rows={rows} folderLabel="Open containing folder" onOpen={noop} onOpenFolder={noop} />,
            { width: 64, height: 14 },
        );
        expect(frame).toContain("volcano.png");
        expect(frame).toContain("heatmap.png");
        expect(frame).toContain("Open containing folder");
    });
});
