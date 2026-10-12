import { describe, expect, test } from "bun:test";

import { PART_REGISTRY } from "./part-registry.js";
import { CompactionPartSchema, ChatPartSchema, PresentationContentSchema, PresentationPartSchema } from "./schemas/chat-parts.js";

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
        expect(ChatPartSchema.parse(part)).toEqual(part);
    });
});

describe("PresentationContentSchema — structure", () => {
    const structure = {
        kind: "structure" as const,
        format: "mmcif" as const,
        url: "https://alphafold.ebi.ac.uk/files/AF-P38398-F1-model_v6.cif",
        provider: "alphafold" as const,
        accession: "P38398",
        version: 6,
    };

    test("accepts a normalized structure content and round-trips it", () => {
        expect(PresentationContentSchema.parse(structure)).toEqual(structure);
        const part = { type: "data-presentation" as const, id: "pres-abc123", title: "BRCA1", content: structure };
        expect(ChatPartSchema.parse(part)).toEqual(part);
    });

    test("rejects a structure content missing a derived field", () => {
        const { accession: _accession, ...noAccession } = structure;
        const { version: _version, ...noVersion } = structure;
        expect(PresentationContentSchema.safeParse(noAccession).success).toBe(false);
        expect(PresentationContentSchema.safeParse(noVersion).success).toBe(false);
        expect(PresentationContentSchema.safeParse({ ...structure, version: 0 }).success).toBe(false);
    });
});

describe("CompactionPartSchema", () => {
    test("accepts a running part and a done part through the union schema", () => {
        const running = { type: "data-compaction" as const, id: "c-1", status: "running" as const, tokensBefore: 162_000 };
        const done = { ...running, status: "done" as const, durationMs: 21_000 };

        expect(ChatPartSchema.parse(running)).toEqual(running);
        expect(ChatPartSchema.parse(done)).toEqual(done);
    });

    test("refuses the status dropped", () => {
        const dropped = { type: "data-compaction" as const, id: "c-1", status: "dropped", tokensBefore: 162_000, durationMs: 3_000 };

        expect(CompactionPartSchema.safeParse(dropped).success).toBe(false);
    });

    test("accepts the tokensAfter of a part that an older harness stored", () => {
        const stored = { type: "data-compaction" as const, id: "c-1", status: "done" as const, tokensBefore: 162_000, tokensAfter: 14_000, durationMs: 21_000 };

        expect(CompactionPartSchema.parse(stored)).toEqual(stored);
    });

    test("is a transient reconciling part of the conversation in the registry", () => {
        expect(PART_REGISTRY["data-compaction"]).toEqual({ emitter: "conversation", consumer: "conversation", transient: true, reconciling: true });
    });

    test("refuses an unknown status and a negative figure", () => {
        const running = { type: "data-compaction" as const, id: "c-1", status: "running" as const, tokensBefore: 162_000 };

        expect(CompactionPartSchema.safeParse({ ...running, status: "paused" }).success).toBe(false);
        expect(CompactionPartSchema.safeParse({ ...running, tokensBefore: -1 }).success).toBe(false);
    });

    test("accepts each trigger, and refuses an unknown trigger", () => {
        const running = { type: "data-compaction" as const, id: "c-1", status: "running" as const, tokensBefore: 162_000 };

        expect(CompactionPartSchema.parse({ ...running, trigger: "turn-start" })).toEqual({ ...running, trigger: "turn-start" });
        expect(CompactionPartSchema.parse({ ...running, trigger: "mid-turn" })).toEqual({ ...running, trigger: "mid-turn" });
        expect(CompactionPartSchema.safeParse({ ...running, trigger: "idle" }).success).toBe(false);
    });
});

describe("the activity history parts", () => {
    test("a data-activity-entry part round-trips through the union schema", () => {
        const entry = {
            type: "data-activity-entry" as const,
            id: "activity-entry-r1-s1-3",
            runId: "r1",
            stepId: "s1",
            phase: "executing" as const,
            activity: "Running script",
            at: "2026-10-12T10:00:00.000Z",
        };
        expect(ChatPartSchema.parse(entry)).toEqual(entry);
        expect(ChatPartSchema.safeParse({ ...entry, at: undefined }).success).toBe(false);
    });

    test("a data-subagent-activity part round-trips through the union schema", () => {
        const part = {
            type: "data-subagent-activity" as const,
            id: "subagent-activity-t1",
            toolCallId: "t1",
            entries: [
                {
                    agentId: "planner",
                    callPath: ["conversation-agent", "planner"],
                    tool: "search_pubmed",
                    label: "TP53",
                    startedAt: "2026-10-12T10:00:00.000Z",
                    endedAt: "2026-10-12T10:00:00.800Z",
                    outcome: "ok" as const,
                },
                { agentId: "planner", callPath: ["conversation-agent", "planner"], tool: "read_file", startedAt: "2026-10-12T10:00:01.000Z" },
            ],
            dropped: 2,
        };
        expect(ChatPartSchema.parse(part)).toEqual(part);
        expect(ChatPartSchema.safeParse({ ...part, dropped: -1 }).success).toBe(false);
    });

    test("the registry marks the two parts", () => {
        expect(PART_REGISTRY["data-subagent-activity"]).toEqual({ emitter: "conversation", consumer: "conversation", transient: false, reconciling: true });
        expect(PART_REGISTRY["data-activity-entry"]).toEqual({ emitter: "workflow", consumer: "sidebar", transient: false, reconciling: false });
    });
});
