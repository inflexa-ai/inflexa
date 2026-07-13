import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { PresentationBlock } from "./presentation_block.tsx";
import type { PresentationBody } from "../../types/session.ts";

// The presentation block renders through the `<markdown>` renderable, which parses asynchronously
// (internalBlockMode="top-level"), so we poll frames until the expected text appears rather than
// capturing a single frame — the same pattern as message_block.test.tsx.
async function frameWith(
    body: PresentationBody,
    title: string | undefined,
    needle: string,
    size = { width: 48, height: 8 },
    timeoutMs = 2000,
): Promise<string> {
    const setup = await testRender(() => <PresentationBlock title={title} body={body} />, size);
    try {
        const start = Date.now();
        for (;;) {
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            if (frame.includes(needle) || Date.now() - start > timeoutMs) return frame;
            await new Promise((r) => setTimeout(r, 10));
        }
    } finally {
        setup.renderer.destroy();
    }
}

describe("PresentationBlock", () => {
    test("renders a markdown body inline under its title", async () => {
        const frame = await frameWith({ kind: "markdown", body: "hello world" }, "Finding", "hello world");
        expect(frame).toContain("hello world");
        expect(frame).toContain("Finding");
    });

    test("renders a code body as a fenced block", async () => {
        const frame = await frameWith({ kind: "code", code: "res <- results(dds)", language: "r" }, undefined, "results");
        expect(frame).toContain("results");
    });

    test("renders a table body inline", async () => {
        const frame = await frameWith({ kind: "table", headers: ["gene", "log2FC"], rows: [["TP53", "2.4"]] }, "Top genes", "TP53");
        expect(frame).toContain("TP53");
    });
});
