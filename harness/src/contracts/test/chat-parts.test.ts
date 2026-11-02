import { describe, expect, test } from "bun:test";

import type { PauseEnd, PauseWaiter } from "../chat-parts.js";
import { PART_REGISTRY } from "../part-registry.js";
import {
    CompactionPartSchema,
    ChatPartSchema,
    PlanApprovalPartSchema,
    PresentationContentSchema,
    PresentationPartSchema,
    RunSynthesisPartSchema,
} from "../schemas/chat-parts.js";
import { presentAt } from "../../lib/present.js";

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

describe("AnalogyReportPartSchema", () => {
    const report = {
        schemaVersion: "1" as const,
        problemSummary: "Noisy induction of a reporter.",
        problemObjects: [{ name: "promoter", role: "input" }],
        problemRelations: ["the promoter drives the reporter"],
        keyTerms: ["induction"],
        analogies: [
            {
                targetDomain: "logistics",
                analogyTitle: "Inventory buffering",
                objectMappings: [],
                sharedRelations: "",
                coverage: "not_loaded" as const,
                solutions: [],
            },
        ],
    };

    test("accepts a part with a report and a part with an extraction-failed envelope through the union schema", () => {
        const withReport = { type: "data-analogy-report" as const, id: "call-1", report };
        const failed = {
            type: "data-analogy-report" as const,
            id: "call-2",
            report: { schemaVersion: "1" as const, error: { kind: "extraction-failed" as const, message: "The problem is empty." } },
        };

        expect(ChatPartSchema.parse(withReport)).toEqual(withReport);
        expect(ChatPartSchema.parse(failed)).toEqual(failed);
    });

    test("refuses a report with an unknown coverage", () => {
        const analogy = { ...presentAt(report.analogies, 0), coverage: "partial" };
        const part = { type: "data-analogy-report", id: "call-1", report: { ...report, analogies: [analogy] } };

        expect(ChatPartSchema.safeParse(part).success).toBe(false);
    });

    test("is a durable part of the conversation in the registry", () => {
        expect(PART_REGISTRY["data-analogy-report"]).toEqual({ emitter: "conversation", consumer: "conversation", transient: false, reconciling: false });
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

describe("PausePartSchema", () => {
    const waiting = {
        type: "data-pause" as const,
        id: "wf-1",
        workId: "run-1",
        workKind: "run" as const,
        state: "paused" as const,
        cause: { kind: "host" as const, reason: "payment_required" },
        pausedAt: "2026-11-02T10:00:00.000Z",
        attempt: 0,
    };

    test("accepts a part in each state", () => {
        const retrying = { ...waiting, state: "retrying" as const, cause: { kind: "outage" as const }, attempt: 1, retryAt: "2026-11-02T10:05:00.000Z" };
        const running = {
            type: "data-pause" as const,
            id: "wf-1",
            workId: "run-1",
            workKind: "run" as const,
            state: "running" as const,
            cause: { kind: "credential" as const },
            pausedAt: waiting.pausedAt,
            endedAt: "2026-11-02T10:30:00.000Z",
            end: "resume" as const,
        };

        expect(ChatPartSchema.parse(waiting)).toEqual(waiting);
        expect(ChatPartSchema.parse(retrying)).toEqual(retrying);
        expect(ChatPartSchema.parse(running)).toEqual(running);
    });

    test("accepts each kind of waiter and keeps it", () => {
        const waiters: PauseWaiter[] = [
            { kind: "turn" },
            { kind: "sub-agent", agentId: "planner" },
            { kind: "step", stepId: "s1" },
            { kind: "synthesis" },
            { kind: "run" },
            { kind: "profile" },
        ];

        for (const waiter of waiters) {
            const part = { ...waiting, waiter };
            expect(ChatPartSchema.parse(part)).toEqual(part);
        }
    });

    test("accepts each end of a wait, and refuses an unknown end", () => {
        const ended = { ...waiting, state: "running" as const, endedAt: "2026-11-02T10:30:00.000Z" };

        const ends: PauseEnd[] = ["retry", "resume", "abort"];
        for (const end of ends) expect(ChatPartSchema.parse({ ...ended, end })).toEqual({ ...ended, end });
        expect(ChatPartSchema.safeParse({ ...ended, end: "timeout" }).success).toBe(false);
    });

    test("accepts a part with no waiter, from a wait that started before the waiter was recorded", () => {
        expect("waiter" in ChatPartSchema.parse(waiting)).toBe(false);
    });

    test("accepts an end part with no endedAt and no end", () => {
        const replayed = { ...waiting, state: "running" as const };

        expect(ChatPartSchema.parse(replayed)).toEqual(replayed);
    });

    test("refuses a part with no pausedAt, and a part with no cause", () => {
        const { pausedAt: _pausedAt, ...noStart } = waiting;
        const { cause: _cause, ...noCause } = waiting;

        expect(ChatPartSchema.safeParse(noStart).success).toBe(false);
        expect(ChatPartSchema.safeParse(noCause).success).toBe(false);
    });

    test("refuses an unknown waiter kind, and a sub-agent waiter with no agent id", () => {
        expect(ChatPartSchema.safeParse({ ...waiting, waiter: { kind: "lease" } }).success).toBe(false);
        expect(ChatPartSchema.safeParse({ ...waiting, waiter: { kind: "sub-agent" } }).success).toBe(false);
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

    test("a data-activity-entry of the synthesis step carries a synthesis phase", () => {
        const entry = {
            type: "data-activity-entry" as const,
            id: "activity-entry-r1-synthesis-0",
            runId: "r1",
            stepId: "synthesis",
            phase: "researching" as const,
            activity: "Reviewing the literature",
            at: "2026-10-12T10:00:00.000Z",
        };
        expect(ChatPartSchema.parse(entry)).toEqual(entry);
    });

    test("a data-synthesis-progress part keeps its time", () => {
        const part = {
            type: "data-synthesis-progress" as const,
            id: "synthesis-progress-r1",
            runId: "r1",
            phase: "drafting" as const,
            activity: "Drafting the synthesis",
            at: "2026-10-12T10:00:00.000Z",
        };
        expect(ChatPartSchema.parse(part)).toEqual(part);
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

describe("the finding of the run synthesis part", () => {
    const finding = {
        stepId: "A",
        title: "Upregulation of FOXP3",
        description: "FOXP3 is upregulated.",
        confidence: "high" as const,
        noveltyStatus: "confirmed" as const,
        literatureInterpretation: "Consistent with prior reports.",
        references: [{ pmid: "12345678", citation: "Smith 2020", relevance: "directly supports", concordance: "supports" as const }],
    };
    const part = {
        type: "data-run-synthesis" as const,
        id: "synthesis-r1",
        runId: "r1",
        overview: "ov",
        findings: [finding],
        themes: [],
        keyReferences: [],
    };

    test("a parse keeps the references of each finding", () => {
        expect(presentAt(RunSynthesisPartSchema.parse(part).findings, 0).references).toEqual(finding.references);
    });

    test("a finding with no references fails the parse", () => {
        const { references: _references, ...bare } = finding;
        expect(RunSynthesisPartSchema.safeParse({ ...part, findings: [bare] }).success).toBe(false);
    });

    test("a concordance outside the four values fails the parse", () => {
        const odd = { ...finding, references: [{ ...presentAt(finding.references, 0), concordance: "agrees" }] };
        expect(RunSynthesisPartSchema.safeParse({ ...part, findings: [odd] }).success).toBe(false);
    });
});

describe("the data-plan-approval part", () => {
    const part = { type: "data-plan-approval" as const, planId: "pln-0000000a", runId: "r1", approvedAt: "2026-10-13T10:00:00.000Z" };

    test("a valid part round-trips through the part schema and the union schema", () => {
        expect(PlanApprovalPartSchema.parse(part)).toEqual(part);
        expect(ChatPartSchema.parse(part)).toEqual(part);
    });

    test("a plan id off the pln-<8hex> shape is refused", () => {
        expect(PlanApprovalPartSchema.safeParse({ ...part, planId: "pln-xyz" }).success).toBe(false);
        expect(PlanApprovalPartSchema.safeParse({ ...part, planId: "plan-0000000a" }).success).toBe(false);
    });

    test("an approvedAt that is not an ISO 8601 date and time is refused", () => {
        expect(PlanApprovalPartSchema.safeParse({ ...part, approvedAt: "yesterday" }).success).toBe(false);
        expect(PlanApprovalPartSchema.safeParse({ ...part, approvedAt: "2026-10-13" }).success).toBe(false);
    });

    test("the registry lists it as a conversation part, not transient and not reconciling", () => {
        expect(PART_REGISTRY["data-plan-approval"]).toEqual({ emitter: "conversation", consumer: "conversation", transient: false, reconciling: false });
    });
});
