import { describe, expect, test } from "bun:test";

import { CortexChatPartSchema, PresentationContentSchema, PresentationPartSchema } from "./schemas/chat-parts.js";

describe("PresentationContentSchema — echart dataPath", () => {
    test("accepts an echart content carrying dataPath and round-trips it (does not strip it)", () => {
        const content = {
            kind: "echart" as const,
            spec: { series: [{ type: "bar" }] },
            dataPath: "runs/run-abc/step-2/output/de-summary.csv",
        };
        const parsed = PresentationContentSchema.parse(content);
        expect(parsed).toEqual(content);
    });

    test("accepts an echart content without dataPath (optional)", () => {
        const content = { kind: "echart" as const, spec: { series: [] } };
        const parsed = PresentationContentSchema.parse(content);
        expect(parsed).toEqual(content);
        expect("dataPath" in parsed).toBe(false);
    });

    test("a full data-presentation part preserves the echart dataPath through the union schema", () => {
        const part = {
            type: "data-presentation" as const,
            id: "pres-abc123",
            title: "DE genes",
            content: {
                kind: "echart" as const,
                spec: { xAxis: {}, yAxis: {}, series: [] },
                dataPath: "runs/run-abc/step-2/output/de-summary.csv",
            },
        };
        expect(PresentationPartSchema.parse(part)).toEqual(part);
        expect(CortexChatPartSchema.parse(part)).toEqual(part);
    });
});
