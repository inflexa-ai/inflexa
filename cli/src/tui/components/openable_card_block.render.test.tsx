import { describe, expect, test } from "bun:test";

import { GLYPHS } from "../../lib/design_system.ts";
import { renderFrame } from "../../test_support/tui.ts";
import { OpenableCardBlock, type OpenableRowView } from "./openable_card_block.tsx";

// Openable cards render synchronous text (no async markdown), so a single frame per size is enough.
// Sweep heights because opentui's yoga quirks (flexShrink / scrollbox overlap) are size-dependent.
const noop = (): void => {};

// The card title and its row names are always DISTINCT strings in these fixtures. Sharing one string
// across both lets a `toContain` pass on whichever element still paints, which is how an invisible
// title once survived a green suite — each assertion has to be able to fail on its own element.
function chartRow(): OpenableRowView {
    return { name: "Volcano plot", path: "/cache/pres-1.html", degraded: false };
}

/**
 * The one frame line carrying `needle`, for assertions that are about a SINGLE element.
 *
 * A claim scoped to the whole frame pins almost nothing in either direction. A `not.toContain` over
 * the frame is satisfied just as well by the marker column not rendering at all as by the intended
 * absence, and a `toContain` is satisfied by whichever element still paints when a string is shared.
 * Requiring exactly one hit makes both failure modes loud: a vanished element and an ambiguous
 * fixture each fail here rather than passing on the wrong line.
 */
function lineWith(frame: string, needle: string): string {
    const hits = frame.split("\n").filter((line) => line.includes(needle));
    expect(hits).toHaveLength(1);
    return hits[0] ?? "";
}

describe("OpenableCardBlock layout", () => {
    for (const height of [6, 12, 24]) {
        test(`title, entry name, and resolved path all render at height ${height}`, async () => {
            const frame = await renderFrame(() => <OpenableCardBlock title="Differential expression" rows={[chartRow()]} onOpen={noop} />, {
                width: 64,
                height,
            });
            expect(frame).toContain("Differential expression");
            expect(frame).toContain("Volcano plot");
            expect(frame).toContain("/cache/pres-1.html");
        });
    }

    test("an openable row is marked with the open-externally affordance, not a content-kind shape", async () => {
        const frame = await renderFrame(() => <OpenableCardBlock title="Differential expression" rows={[chartRow()]} onOpen={noop} />, {
            width: 64,
            height: 8,
        });
        expect(frame).toContain(`${GLYPHS.arrowUpRight} Volcano plot`);
        // The title carries no marker of its own — a bold heading above indented rows already reads as a
        // group. Scoped to the title's own line so the claim rests on a title that demonstrably painted.
        const title = lineWith(frame, "Differential expression");
        expect(title).not.toContain(GLYPHS.circle);
        expect(title).not.toContain(GLYPHS.arrowUpRight);
    });

    test("a degraded entry renders (missing/failed) without crashing, marked as broken rather than openable", async () => {
        const frame = await renderFrame(
            () => <OpenableCardBlock rows={[{ name: "Report preview v2 failed", caption: "render timed out", path: null, degraded: true }]} onOpen={noop} />,
            { width: 64, height: 8 },
        );
        // The marker, the name, and the caption share one rendered line, so the whole claim — broken
        // marker present, open affordance absent — is made against that row and not against the frame.
        const row = lineWith(frame, "Report preview v2 failed");
        expect(row).toContain(`${GLYPHS.cross} Report preview v2 failed`);
        expect(row).toContain("render timed out");
        expect(row).not.toContain(GLYPHS.arrowUpRight);
    });

    test("a multi-file gallery shows every row plus the folder affordance, all under one marker", async () => {
        const rows: OpenableRowView[] = [
            { name: "volcano.png", path: "/ws/figures/volcano.png", degraded: false },
            { name: "heatmap.png", path: "/ws/figures/heatmap.png", degraded: false },
        ];
        const frame = await renderFrame(
            () => <OpenableCardBlock title="Figures" rows={rows} folderLabel="Open containing folder" onOpen={noop} onOpenFolder={noop} />,
            { width: 64, height: 14 },
        );
        // "Figures" is one lowercasing away from the `/ws/figures/` path segment two lines below, so a
        // frame-wide toContain would rest on a case difference to be about the title at all.
        expect(lineWith(frame, "Figures")).toContain("Figures");
        expect(frame).toContain(`${GLYPHS.arrowUpRight} volcano.png`);
        expect(frame).toContain(`${GLYPHS.arrowUpRight} heatmap.png`);
        // The folder row opens externally too, so it shares the marker; its muted label sets it apart.
        expect(frame).toContain(`${GLYPHS.arrowUpRight} Open containing folder`);
    });
});
