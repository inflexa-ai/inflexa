/**
 * These schemas are the only in-repo guard on the chat-event wire vocabulary.
 * `CortexChatEvent` has no consumer in this repository — a host types against
 * it — so nothing else would catch the types and the schemas drifting apart.
 */

import { describe, expect, it } from "bun:test";
import type { z } from "zod";

import { CortexChatEventSchema, ToolFinishedEventSchema, ToolOutcomeSchema, ToolStartedEventSchema } from "./chat-events.js";

type ToolStarted = z.infer<typeof ToolStartedEventSchema>;
type ToolFinished = z.infer<typeof ToolFinishedEventSchema>;

const source = { agentId: "conversation-agent", callPath: ["conversation-agent"] };

describe("ToolOutcomeSchema", () => {
    it("admits exactly the three outcomes", () => {
        expect(ToolOutcomeSchema.parse("ok")).toBe("ok");
        expect(ToolOutcomeSchema.parse("error")).toBe("error");
        expect(ToolOutcomeSchema.parse("denied")).toBe("denied");
    });

    it("rejects a boolean, the shape it replaced", () => {
        expect(ToolOutcomeSchema.safeParse(true).success).toBe(false);
        expect(ToolOutcomeSchema.safeParse("failed").success).toBe(false);
    });
});

describe("ToolStartedEventSchema", () => {
    it("accepts an event carrying a detail", () => {
        const event: ToolStarted = { type: "tool-started", toolUseId: "tu-1", name: "read_file", detail: "output/summary.md", source };

        expect(ToolStartedEventSchema.parse(event)).toEqual(event);
    });

    it("accepts an event with no detail — absence is a normal state", () => {
        const event: ToolStarted = { type: "tool-started", toolUseId: "tu-1", name: "list_files", source };

        const parsed = ToolStartedEventSchema.parse(event);

        expect(parsed).toEqual(event);
        expect("detail" in parsed).toBe(false);
    });

    it("rejects a non-string detail", () => {
        expect(ToolStartedEventSchema.safeParse({ type: "tool-started", toolUseId: "tu-1", name: "read_file", detail: 42, source }).success).toBe(false);
    });
});

describe("ToolFinishedEventSchema", () => {
    it("accepts each outcome, with and without a detail", () => {
        for (const outcome of ["ok", "error", "denied"] as const) {
            const event: ToolFinished = { type: "tool-finished", toolUseId: "tu-1", name: "write_file", outcome, source };

            expect(ToolFinishedEventSchema.parse(event)).toEqual(event);
            expect(ToolFinishedEventSchema.parse({ ...event, detail: "output/x.csv" }).detail).toBe("output/x.csv");
        }
    });

    it("requires the outcome — it is not optional", () => {
        expect(ToolFinishedEventSchema.safeParse({ type: "tool-finished", toolUseId: "tu-1", name: "write_file", source }).success).toBe(false);
    });

    it("carries an optional duration, and omits the key when it is absent", () => {
        // `z.object` STRIPS an undeclared key. Thus a schema that loses the
        // `durationMs` line drops the field silently, and a fixture that never
        // sets it passes either way. The round-trip is what pins the declaration.
        const event: ToolFinished = { type: "tool-finished", toolUseId: "tu-1", name: "write_file", outcome: "ok", source };

        expect(ToolFinishedEventSchema.parse({ ...event, durationMs: 42 }).durationMs).toBe(42);
        expect("durationMs" in ToolFinishedEventSchema.parse(event)).toBe(false);
    });

    it("rejects a non-numeric duration", () => {
        const event = { type: "tool-finished", toolUseId: "tu-1", name: "write_file", outcome: "ok", durationMs: "42", source };

        expect(ToolFinishedEventSchema.safeParse(event).success).toBe(false);
    });

    it("rejects the isError boolean it replaced", () => {
        const legacy = { type: "tool-finished", toolUseId: "tu-1", name: "write_file", isError: false, source };

        expect(ToolFinishedEventSchema.safeParse(legacy).success).toBe(false);
    });
});

describe("CortexChatEventSchema", () => {
    it("discriminates the tool events by type", () => {
        const started = CortexChatEventSchema.parse({ type: "tool-started", toolUseId: "tu-1", name: "pubmed", detail: "search BRCA1", source });
        const finished = CortexChatEventSchema.parse({ type: "tool-finished", toolUseId: "tu-1", name: "pubmed", outcome: "denied", source });

        expect(started.type).toBe("tool-started");
        expect(finished).toMatchObject({ type: "tool-finished", outcome: "denied" });
    });
});
