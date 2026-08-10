/**
 * The tests of the authoring tool surface.
 *
 * Each test drives a tool through `execute` with a minimal tool context and an in-memory gateway. The core
 * operations have their own tests, thus these tests cover the flat-to-core map, the ok-channel refusal, the
 * gateway persist, the per-thread isolation, and the tool-layer refusals.
 */

import { describe, expect, it } from "bun:test";

import type { Scope } from "../../auth/types.js";
import type { DraftDocument } from "../../report-model/draft.js";
import type { ReportSnapshot } from "../../report-model/reference-resolver.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import type { ToolContext } from "../define-tool.js";
import {
    createReportAuthoringTools,
    type ReportSessionState,
    type ReportSessionStateGateway,
    type SessionStateLoad,
    type SessionStatePersist,
    type StampResult,
} from "./authoring-tools.js";

/** The authoring tools read and write the draft only, thus a stamp is a no-op stub in these tests. */
const stampStubs = {
    stampRendered: (): Promise<StampResult> => Promise.resolve({ outcome: "stamped" }),
    stampSeen: (): Promise<StampResult> => Promise.resolve({ outcome: "stamped" }),
};

/** An empty snapshot. No test here needs a resolvable artifact, thus the map holds nothing. */
const snapshot: ReportSnapshot = { artifacts: {} };

/** An empty draft, as a legal draft state. */
function emptyDraft(): DraftDocument {
    return { title: "", sections: [] };
}

/** A section with one empty child slot, as a legal draft state. */
function oneSectionDraft(): DraftDocument {
    return { title: "", sections: [{ kind: "section", id: "s1", title: "Intro", blocks: [] }] };
}

/** The default analysis of a seeded thread. It matches the scope of `ctxForThread`, thus a call resolves. */
const DEFAULT_ANALYSIS_ID = "analysis-001";

/**
 * An in-memory gateway. It holds one state and one analysis for each thread, thus two threads stay
 * isolated. The load and the persist read and write the same map, thus a landed document is visible to the
 * next load. The load hands the persist the prior document as the concurrency token. The full fault fails
 * the load and the persist. The persist-only fault fails the persist but keeps the load, thus a test can
 * isolate a land-time persist failure. The store clones each value to model a durable round trip.
 */
interface FakeGateway extends ReportSessionStateGateway {
    seed(threadId: string, state: ReportSessionState, analysisId?: string): void;
    peek(threadId: string): ReportSessionState | undefined;
    setFault(fault: boolean): void;
    setPersistFault(fault: boolean): void;
}

function makeFakeGateway(): FakeGateway {
    const rows = new Map<string, { state: ReportSessionState; analysisId: string }>();
    let fault = false;
    let persistFault = false;
    return {
        seed(threadId, state, analysisId = DEFAULT_ANALYSIS_ID): void {
            rows.set(threadId, { state: structuredClone(state), analysisId });
        },
        peek(threadId): ReportSessionState | undefined {
            const row = rows.get(threadId);
            return row === undefined ? undefined : structuredClone(row.state);
        },
        setFault(value): void {
            fault = value;
        },
        setPersistFault(value): void {
            persistFault = value;
        },
        load(threadId): Promise<SessionStateLoad> {
            if (fault) {
                return Promise.resolve({ outcome: "failed", detail: "the store is down" });
            }
            const row = rows.get(threadId);
            if (row === undefined) {
                return Promise.resolve({ outcome: "absent" });
            }
            const state = structuredClone(row.state);
            return Promise.resolve({ outcome: "found", state, analysisId: row.analysisId, token: state.document, seenDocumentHash: null });
        },
        ...stampStubs,
        persist(threadId, document): Promise<SessionStatePersist> {
            if (fault) {
                return Promise.resolve({ outcome: "failed", detail: "the store is down" });
            }
            // The persist-only fault names a distinct detail, thus a test tells the persist branch from the load branch.
            if (persistFault) {
                return Promise.resolve({ outcome: "failed", detail: "the persist failed" });
            }
            const existing = rows.get(threadId);
            const snapshotOfThread = existing?.state.snapshot ?? snapshot;
            const analysisId = existing?.analysisId ?? DEFAULT_ANALYSIS_ID;
            rows.set(threadId, { state: { document: structuredClone(document), snapshot: snapshotOfThread }, analysisId });
            return Promise.resolve({ outcome: "persisted" });
        },
    };
}

/** A tool context whose scope names a report thread. */
function ctxForThread(threadId: string): ToolContext {
    const { ctx } = makeToolContext();
    const scope: Scope = { kind: "analysis", analysisId: DEFAULT_ANALYSIS_ID, threadId };
    return { ...ctx, session: { ...ctx.session, scope } };
}

/** A tool context whose scope names a resource of a different kind, thus it carries no thread id. */
function ctxOtherKind(): ToolContext {
    const { ctx } = makeToolContext();
    const scope: Scope = { kind: "target-assessment", targetAssessmentId: "ta-001", billingContextId: "bc-001" };
    return { ...ctx, session: { ...ctx.session, scope } };
}

describe("add_block", () => {
    it("lands a section on an empty draft, reports the root container, and the gateway holds it", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: emptyDraft(), snapshot });
        const tools = createReportAuthoringTools(gateway);

        const result = await tools.add_block.execute({ block: { kind: "section", id: "s1", title: "Intro", blocks: [] } }, ctxForThread("t1"));

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(true);
        if (value.applied) {
            expect(value.changed).toEqual([{ children: [{ id: "s1", kind: "section", depth: 0, label: "Intro" }] }]);
        }
        // The gateway holds the new document, thus the persist ran before the tool reported the landing.
        expect(gateway.peek("t1")!.document.sections.map((section) => section.id)).toEqual(["s1"]);
    });

    it("refuses a reference outside the snapshot, and the gateway document stays unchanged", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: oneSectionDraft(), snapshot });
        const tools = createReportAuthoringTools(gateway);
        const metric = {
            kind: "metric",
            id: "m1",
            label: "count",
            value: { kind: "artifact-value", path: "does/not/exist.csv", hash: "sha256:abc", locator: { column: "n", row: 0 } },
        };

        const result = await tools.add_block.execute({ block: metric, parentId: "s1" }, ctxForThread("t1"));

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(false);
        if (!value.applied) {
            expect(value.refusal.reason).toBe("unresolved-reference");
        }
        // The refusal ran no persist, thus the row stays the seeded draft.
        expect(gateway.peek("t1")!.document.sections).toHaveLength(1);
        expect(gateway.peek("t1")!.document.sections[0]!.blocks).toEqual([]);
    });

    it("refuses `before` and `after` together, and names the conflict", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: emptyDraft(), snapshot });
        const tools = createReportAuthoringTools(gateway);

        const result = await tools.add_block.execute(
            { block: { kind: "section", id: "s2", title: "X", blocks: [] }, before: "a", after: "b" },
            ctxForThread("t1"),
        );

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(false);
        if (!value.applied) {
            expect(value.refusal.reason).toBe("conflicting-destination");
            expect(value.refusal.detail).toContain("before");
        }
        expect(gateway.peek("t1")!.document.sections).toEqual([]);
    });

    it("publishes the block grammar in its JSON schema", () => {
        const tools = createReportAuthoringTools(makeFakeGateway());
        const schema = JSON.stringify(tools.add_block.jsonSchema);

        // The model learns the payload shape from the schema alone, thus the eight kinds must be in it.
        for (const kind of ["section", "text", "claim", "metric", "table", "chart", "figure", "citation"]) {
            expect(schema).toContain(`"const":"${kind}"`);
        }
    });

    it("decodes a block payload that arrives as a JSON string", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: oneSectionDraft(), snapshot });
        const tools = createReportAuthoringTools(gateway);
        const encoded = JSON.stringify({ kind: "text", id: "t1", content: { prose: "x" } });

        const value = (await tools.add_block.execute({ block: encoded, parentId: "s1" }, ctxForThread("t1")))._unsafeUnwrap();

        expect(value.applied).toBe(true);
        expect(gateway.peek("t1")!.document.sections[0]!.blocks.map((block) => block.id)).toEqual(["t1"]);
    });

    it("accepts an explicit null in each destination field that the call does not use", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: oneSectionDraft(), snapshot });
        const tools = createReportAuthoringTools(gateway);
        const input = { block: { kind: "text", id: "t1", content: { prose: "x" } }, parentId: "s1", place: null, before: null, after: null };

        // Strict function calling requires every declared key, thus the unused anchors arrive as null.
        expect(tools.add_block.inputSchema.safeParse(input).success).toBe(true);

        const value = (await tools.add_block.execute(input, ctxForThread("t1")))._unsafeUnwrap();
        expect(value.applied).toBe(true);
        expect(gateway.peek("t1")!.document.sections[0]!.blocks.map((block) => block.id)).toEqual(["t1"]);
    });
});

describe("the tool-layer refusal", () => {
    it("refuses a call whose scope carries no thread id, and nothing persists", async () => {
        const gateway = makeFakeGateway();
        const tools = createReportAuthoringTools(gateway);
        // The default fixture scope is an analysis scope with no thread id.
        const { ctx } = makeToolContext();

        const result = await tools.add_block.execute({ block: { kind: "section", id: "s1", title: "Intro", blocks: [] } }, ctx);

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(false);
        if (!value.applied) {
            expect(value.refusal.reason).toBe("no-thread-scope");
        }
    });

    it("refuses a call whose scope names a resource of a different kind", async () => {
        const tools = createReportAuthoringTools(makeFakeGateway());

        const result = await tools.add_block.execute({ block: { kind: "section", id: "s1", title: "Intro", blocks: [] } }, ctxOtherKind());

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(false);
        if (!value.applied) {
            expect(value.refusal.reason).toBe("no-thread-scope");
        }
    });

    it("refuses a call whose thread id is not a safe segment", async () => {
        const gateway = makeFakeGateway();
        const tools = createReportAuthoringTools(gateway);
        // A thread id that carries a traversal segment names no thread a tool can write under.
        const { ctx } = makeToolContext();
        const scope: Scope = { kind: "analysis", analysisId: "analysis-001", threadId: "../evil" };
        const unsafeCtx: ToolContext = { ...ctx, session: { ...ctx.session, scope } };

        const result = await tools.add_block.execute({ block: { kind: "section", id: "s1", title: "Intro", blocks: [] } }, unsafeCtx);

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(false);
        if (!value.applied) {
            expect(value.refusal.reason).toBe("no-thread-scope");
        }
    });

    it("refuses a mutation on a thread with no stored state", async () => {
        const tools = createReportAuthoringTools(makeFakeGateway());

        const result = await tools.add_block.execute({ block: { kind: "section", id: "s1", title: "Intro", blocks: [] } }, ctxForThread("absent"));

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(false);
        if (!value.applied) {
            expect(value.refusal.reason).toBe("absent-state");
        }
    });

    it("refuses a read on a thread with no stored state", async () => {
        const tools = createReportAuthoringTools(makeFakeGateway());

        const outline = (await tools.read_outline.execute({}, ctxForThread("absent")))._unsafeUnwrap();

        expect("refused" in outline).toBe(true);
        if ("refused" in outline) {
            expect(outline.refused.reason).toBe("absent-state");
        }
    });

    it("refuses when the gateway reports a failure", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: emptyDraft(), snapshot });
        gateway.setFault(true);
        const tools = createReportAuthoringTools(gateway);

        const result = await tools.add_block.execute({ block: { kind: "section", id: "s1", title: "Intro", blocks: [] } }, ctxForThread("t1"));

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(false);
        if (!value.applied) {
            expect(value.refusal.reason).toBe("state-unavailable");
        }
    });

    it("refuses at the persist step, and the gateway holds the old document", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: oneSectionDraft(), snapshot });
        // Only the persist fails. Thus the load gives the state, and the add lands in the pure core first.
        gateway.setPersistFault(true);
        const tools = createReportAuthoringTools(gateway);

        const result = await tools.add_block.execute({ block: { kind: "text", id: "t1", content: { prose: "x" } }, parentId: "s1" }, ctxForThread("t1"));

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(false);
        if (!value.applied) {
            expect(value.refusal.reason).toBe("state-unavailable");
            // The detail comes from the persist, thus the refusal is the persist branch and not the load branch.
            expect(value.refusal.detail).toBe("the persist failed");
        }
        // The persist failed after the add landed, thus the row keeps the old draft with an empty section.
        expect(gateway.peek("t1")!.document.sections[0]!.blocks).toEqual([]);
    });

    it("refuses a scope whose analysis differs from the analysis that owns the thread, and nothing persists", async () => {
        const gateway = makeFakeGateway();
        // The thread belongs to a different analysis than the scope of the call.
        gateway.seed("t1", { document: oneSectionDraft(), snapshot }, "analysis-999");
        const tools = createReportAuthoringTools(gateway);

        const result = await tools.add_block.execute({ block: { kind: "text", id: "t9", content: { prose: "x" } }, parentId: "s1" }, ctxForThread("t1"));

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(false);
        if (!value.applied) {
            expect(value.refusal.reason).toBe("scope-analysis-mismatch");
            expect(value.refusal.detail).toContain("analysis-001");
            expect(value.refusal.detail).toContain("analysis-999");
        }
        // The mismatch ran no persist, thus the seeded draft stays.
        expect(gateway.peek("t1")!.document.sections[0]!.blocks).toEqual([]);
    });

    it("refuses a wrong thread type with a permanent reason", async () => {
        // A gateway whose load reports a wrong thread type, the permanent condition the runtime distinguishes.
        const gateway: ReportSessionStateGateway = {
            load: () => Promise.resolve({ outcome: "wrong-type", detail: "the thread is a conversation thread, not a report thread" }),
            persist: () => Promise.resolve({ outcome: "persisted" }),
            ...stampStubs,
        };
        const tools = createReportAuthoringTools(gateway);

        const result = await tools.add_block.execute({ block: { kind: "section", id: "s1", title: "Intro", blocks: [] } }, ctxForThread("t1"));

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(false);
        if (!value.applied) {
            expect(value.refusal.reason).toBe("wrong-thread-type");
            expect(value.refusal.detail).toContain("permanent");
        }
    });

    it("refuses a landing when a concurrent turn changed the report first", async () => {
        // A gateway whose persist reports a conflict, the compare-and-swap outcome of the durable store.
        const gateway: ReportSessionStateGateway = {
            load: () =>
                Promise.resolve({
                    outcome: "found",
                    state: { document: oneSectionDraft(), snapshot },
                    analysisId: "analysis-001",
                    token: null,
                    seenDocumentHash: null,
                }),
            persist: () => Promise.resolve({ outcome: "conflict" }),
            ...stampStubs,
        };
        const tools = createReportAuthoringTools(gateway);

        const result = await tools.add_block.execute({ block: { kind: "text", id: "t1", content: { prose: "x" } }, parentId: "s1" }, ctxForThread("t1"));

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(false);
        if (!value.applied) {
            expect(value.refusal.reason).toBe("stale-state");
        }
    });
});

describe("change_block", () => {
    it("retitles a section from a call that names no block", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: oneSectionDraft(), snapshot });
        const tools = createReportAuthoringTools(gateway);
        // The loop validates against `inputSchema` before it runs `execute`, thus the retitle call must
        // pass the schema with the `block` key absent.
        const input = JSON.parse('{"targetId":"s1","title":"Results"}') as Record<string, unknown>;
        expect(tools.change_block.inputSchema.safeParse(input).success).toBe(true);

        const value = (await tools.change_block.execute(input, ctxForThread("t1")))._unsafeUnwrap();

        expect(value.applied).toBe(true);
        expect(gateway.peek("t1")!.document.sections[0]!.title).toBe("Results");
    });

    it("retitles a section when the unused block field arrives as null", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: oneSectionDraft(), snapshot });
        const tools = createReportAuthoringTools(gateway);

        // Strict function calling sends the unused `block` field as null, thus the retitle still lands.
        const value = (await tools.change_block.execute({ targetId: "s1", title: "Results", block: null }, ctxForThread("t1")))._unsafeUnwrap();

        expect(value.applied).toBe(true);
        expect(gateway.peek("t1")!.document.sections[0]!.title).toBe("Results");
    });

    it("refuses a change that names neither a title nor a block", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: oneSectionDraft(), snapshot });
        const tools = createReportAuthoringTools(gateway);

        const result = await tools.change_block.execute({ targetId: "s1" }, ctxForThread("t1"));

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(false);
        if (!value.applied) {
            expect(value.refusal.reason).toBe("payload-kind-mismatch");
        }
    });
});

describe("remove_block", () => {
    it("lands a removal, and reports the container that the block left", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", {
            document: {
                title: "",
                sections: [{ kind: "section", id: "s1", title: "Intro", blocks: [{ kind: "text", id: "t1", content: { prose: "x" } }] }],
            },
            snapshot,
        });
        const tools = createReportAuthoringTools(gateway);

        const result = await tools.remove_block.execute({ targetId: "t1" }, ctxForThread("t1"));

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(true);
        if (value.applied) {
            expect(value.changed).toEqual([{ parentId: "s1", children: [] }]);
        }
    });
});

describe("move_block", () => {
    it("lands a move with a flat anchor, and reports the new child order", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", {
            document: {
                title: "",
                sections: [
                    {
                        kind: "section",
                        id: "s1",
                        title: "Intro",
                        blocks: [
                            { kind: "text", id: "t1", content: { prose: "a" } },
                            { kind: "text", id: "t2", content: { prose: "b" } },
                        ],
                    },
                ],
            },
            snapshot,
        });
        const tools = createReportAuthoringTools(gateway);

        const result = await tools.move_block.execute({ targetId: "t1", after: "t2" }, ctxForThread("t1"));

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(true);
        if (value.applied) {
            // The move stays inside one container, thus that container is reported one time.
            expect(value.changed).toHaveLength(1);
            expect(value.changed[0]!.parentId).toBe("s1");
            expect(value.changed[0]!.children.map((entry) => entry.id)).toEqual(["t2", "t1"]);
        }
    });
});

describe("set_title", () => {
    it("sets the document title, and the finish then gives the document", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", {
            document: {
                title: "",
                sections: [{ kind: "section", id: "s1", title: "Intro", blocks: [{ kind: "text", id: "t1", content: { prose: "x" } }] }],
            },
            snapshot,
        });
        const tools = createReportAuthoringTools(gateway);
        const ctx = ctxForThread("t1");

        const untitled = (await tools.finish_draft.execute({}, ctx))._unsafeUnwrap();
        expect("valid" in untitled && untitled.valid).toBe(false);
        if ("valid" in untitled && !untitled.valid) {
            expect(untitled.gaps).toContainEqual({ kind: "schema", path: "title", message: expect.stringContaining(">=1") });
        }

        const set = (await tools.set_title.execute({ title: "Differential expression" }, ctx))._unsafeUnwrap();
        expect(set.applied).toBe(true);

        const titled = (await tools.finish_draft.execute({}, ctx))._unsafeUnwrap();
        expect("valid" in titled && titled.valid).toBe(true);
        if ("valid" in titled && titled.valid) {
            expect(titled.document.title).toBe("Differential expression");
        }
    });
});

describe("read_block", () => {
    it("names its target with the same field as each mutation tool", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: oneSectionDraft(), snapshot });
        const tools = createReportAuthoringTools(gateway);

        const value = (await tools.read_block.execute({ targetId: "s1" }, ctxForThread("t1")))._unsafeUnwrap();

        expect("found" in value && value.found).toBe(true);
        expect(tools.read_block.inputSchema.safeParse({ id: "s1" }).success).toBe(false);
    });

    it("gives a section without its subtree", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", {
            document: {
                title: "",
                sections: [{ kind: "section", id: "s1", title: "Intro", blocks: [{ kind: "text", id: "t1", content: { prose: "a long body" } }] }],
            },
            snapshot,
        });
        const tools = createReportAuthoringTools(gateway);

        const value = (await tools.read_block.execute({ targetId: "s1" }, ctxForThread("t1")))._unsafeUnwrap();

        expect(value).toEqual({ found: true, block: { kind: "section", id: "s1", title: "Intro", childIds: ["t1"] } });
    });

    it("gives `found: false` for an unknown id", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: oneSectionDraft(), snapshot });
        const tools = createReportAuthoringTools(gateway);

        const result = await tools.read_block.execute({ targetId: "nope" }, ctxForThread("t1"));

        expect(result._unsafeUnwrap()).toEqual({ found: false });
    });
});

describe("the tool surface", () => {
    it("runs every tool inline, because a step-mode replay could report a stale outline", () => {
        const tools = createReportAuthoringTools(makeFakeGateway());
        const packaged = [
            tools.add_block,
            tools.change_block,
            tools.remove_block,
            tools.move_block,
            tools.set_title,
            tools.read_outline,
            tools.read_block,
            tools.finish_draft,
        ];

        expect(packaged.map((tool) => tool.executionMode)).toEqual(Array(8).fill("inline"));
    });
});

describe("finish_draft", () => {
    it("reports a gap for an empty draft", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: emptyDraft(), snapshot });
        const tools = createReportAuthoringTools(gateway);

        const value = (await tools.finish_draft.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect("valid" in value && value.valid).toBe(false);
        if ("valid" in value && !value.valid) {
            expect(value.gaps.length).toBeGreaterThan(0);
        }
    });

    it("gives the document for a complete draft", async () => {
        const complete: DraftDocument = {
            title: "Report",
            sections: [{ kind: "section", id: "s1", title: "Intro", blocks: [{ kind: "text", id: "t1", content: { prose: "hello" } }] }],
        };
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: complete, snapshot });
        const tools = createReportAuthoringTools(gateway);

        const value = (await tools.finish_draft.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect("valid" in value && value.valid).toBe(true);
        if ("valid" in value && value.valid) {
            expect(value.document).toEqual(complete);
        }
    });
});

describe("thread isolation", () => {
    it("keeps two threads independent through one factory", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("tA", { document: emptyDraft(), snapshot });
        gateway.seed("tB", { document: emptyDraft(), snapshot });
        const tools = createReportAuthoringTools(gateway);

        const addedA = await tools.add_block.execute({ block: { kind: "section", id: "sA", title: "A", blocks: [] } }, ctxForThread("tA"));
        expect(addedA._unsafeUnwrap().applied).toBe(true);
        const addedB = await tools.add_block.execute({ block: { kind: "section", id: "sB", title: "B", blocks: [] } }, ctxForThread("tB"));
        expect(addedB._unsafeUnwrap().applied).toBe(true);

        const outlineA = (await tools.read_outline.execute({}, ctxForThread("tA")))._unsafeUnwrap();
        expect("outline" in outlineA && outlineA.outline.map((entry) => entry.id)).toEqual(["sA"]);

        const outlineB = (await tools.read_outline.execute({}, ctxForThread("tB")))._unsafeUnwrap();
        expect("outline" in outlineB && outlineB.outline.map((entry) => entry.id)).toEqual(["sB"]);

        // Each row holds only its own block.
        expect(gateway.peek("tA")!.document.sections.map((section) => section.id)).toEqual(["sA"]);
        expect(gateway.peek("tB")!.document.sections.map((section) => section.id)).toEqual(["sB"]);
    });
});

describe("the cost of a landing", () => {
    it("reports the changed container only, and not the whole draft", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: emptyDraft(), snapshot });
        const tools = createReportAuthoringTools(gateway);
        const ctx = ctxForThread("t1");
        await tools.add_block.execute({ block: { kind: "section", id: "s1", title: "First", blocks: [] } }, ctx);
        await tools.add_block.execute({ block: { kind: "text", id: "t1", content: { prose: "in the first section" } }, parentId: "s1" }, ctx);
        await tools.add_block.execute({ block: { kind: "section", id: "s2", title: "Second", blocks: [] } }, ctx);

        const result = await tools.add_block.execute({ block: { kind: "text", id: "t2", content: { prose: "x" } }, parentId: "s2" }, ctx);

        // A whole outline would grow with the draft on every landing, thus authoring n blocks would cost
        // n-squared outline entries of agent context.
        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(true);
        if (value.applied) {
            expect(value.changed).toEqual([{ parentId: "s2", children: [{ id: "t2", kind: "text", depth: 1, label: "x" }] }]);
            expect(JSON.stringify(value)).not.toContain("in the first section");
        }
    });

    it("reports both containers of a move across sections", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", {
            document: {
                title: "",
                sections: [
                    { kind: "section", id: "s1", title: "First", blocks: [{ kind: "text", id: "t1", content: { prose: "a" } }] },
                    { kind: "section", id: "s2", title: "Second", blocks: [{ kind: "text", id: "t2", content: { prose: "b" } }] },
                ],
            },
            snapshot,
        });
        const tools = createReportAuthoringTools(gateway);

        const across = (await tools.move_block.execute({ targetId: "t1", parentId: "s2", place: "end" }, ctxForThread("t1")))._unsafeUnwrap();

        expect(across.applied).toBe(true);
        if (across.applied) {
            expect(across.changed.map((container) => container.parentId)).toEqual(["s1", "s2"]);
            expect(across.changed[0]!.children).toEqual([]);
            expect(across.changed[1]!.children.map((entry) => entry.id)).toEqual(["t2", "t1"]);
        }
    });

    it("reports no container for a title, which changes no child order", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: oneSectionDraft(), snapshot });
        const tools = createReportAuthoringTools(gateway);

        const value = (await tools.set_title.execute({ title: "Report" }, ctxForThread("t1")))._unsafeUnwrap();

        expect(value).toEqual({ applied: true, changed: [] });
    });
});
