/**
 * The tests of the authoring tool surface.
 *
 * Each test drives a tool through `execute` with a minimal tool context and an in-memory gateway. The core
 * operations have their own tests, thus these tests cover the flat-to-core map, the ok-channel refusal, the
 * gateway persist, the per-thread isolation, and the tool-layer refusals.
 */

import { describe, expect, it } from "bun:test";

import type { Scope } from "../../auth/types.js";
import { normalizeDetail } from "../../loop/tool-detail.js";
import type { DraftDocument } from "../../report-model/draft.js";
import type { ReportSnapshot } from "../../report-model/reference-resolver.js";
import { createCapturingLogger } from "../../__tests__/setup/logger.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import type { ToolContext } from "../define-tool.js";
import type { ReportObservationEvent } from "../report-observation.js";
import {
    createReportAuthoringTools,
    type ReportAuthoringTools,
    type ReportAuthoringToolDeps,
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

/** An empty snapshot. Most tests here need no resolvable artifact, thus the map holds nothing. */
const snapshot: ReportSnapshot = { artifacts: {} };

/** The hash of the one pinned artifact of a test that binds a block. */
const PINNED_HASH = `sha256:${"a".repeat(64)}`;

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
            return Promise.resolve({ outcome: "found", state, analysisId: row.analysisId, token: state.document, seenDocumentHash: null, derivations: [] });
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

    it("publishes no hash field on a reference of its input schema", () => {
        const tools = createReportAuthoringTools(makeFakeGateway());

        for (const tool of [tools.add_block, tools.change_block]) {
            const schema = JSON.stringify(tool.jsonSchema);
            // The pinned snapshot owns the hash, thus the model reads no field that it could fill wrong.
            expect(schema).not.toContain('"hash"');
            expect(schema).toContain('"path"');
        }
    });

    it("lands a binding that echoes a stored hash, because the stamp decides the value", async () => {
        const path = "runs/r1/s1/output/de.csv";
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: oneSectionDraft(), snapshot: { artifacts: { [path]: { hash: PINNED_HASH, fileType: "output" } } } });
        const tools = createReportAuthoringTools(gateway);
        const block = { kind: "table", id: "tb1", binding: { kind: "artifact-table", path, hash: `sha256:${"c".repeat(64)}` } };

        const value = (await tools.add_block.execute({ block, parentId: "s1" }, ctxForThread("t1")))._unsafeUnwrap();

        expect(value.applied).toBe(true);
        const landed = gateway.peek("t1")!.document.sections[0]!.blocks[0]!;
        expect(landed.kind === "table" ? landed.binding.hash : undefined).toBe(PINNED_HASH);
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

    it("lands a text block that carries a typed list, and the gateway holds each item", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: oneSectionDraft(), snapshot });
        const tools = createReportAuthoringTools(gateway);
        const block = { kind: "text", id: "t1", content: { prose: "Two limits bound the reading.", list: { ordered: true, items: ["One.", "Two."] } } };

        const value = (await tools.add_block.execute({ block, parentId: "s1" }, ctxForThread("t1")))._unsafeUnwrap();

        expect(value.applied).toBe(true);
        // The draft grammar composes from the contract atoms, thus the field reaches the tool with no
        // payload of its own and the stored draft keeps it.
        const landed = gateway.peek("t1")!.document.sections[0]!.blocks[0]!;
        expect(landed.kind === "text" ? landed.content.list : undefined).toEqual({ ordered: true, items: ["One.", "Two."] });
    });

    it("refuses a text block whose list holds no item", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: oneSectionDraft(), snapshot });
        const tools = createReportAuthoringTools(gateway);
        const block = { kind: "text", id: "t1", content: { prose: "Lead.", list: { ordered: true, items: [] } } };

        const value = (await tools.add_block.execute({ block, parentId: "s1" }, ctxForThread("t1")))._unsafeUnwrap();

        expect(value.applied).toBe(false);
        expect(gateway.peek("t1")!.document.sections[0]!.blocks).toEqual([]);
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
                    derivations: [],
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

    it("gives an atom whose binding carries no hash", async () => {
        const path = "runs/r1/s1/output/de.csv";
        const gateway = makeFakeGateway();
        gateway.seed("t1", {
            document: {
                title: "",
                sections: [
                    {
                        kind: "section",
                        id: "s1",
                        title: "Intro",
                        blocks: [{ kind: "table", id: "tb1", binding: { kind: "artifact-table", path, hash: PINNED_HASH } }],
                    },
                ],
            },
            snapshot,
        });
        const tools = createReportAuthoringTools(gateway);

        const value = (await tools.read_block.execute({ targetId: "tb1" }, ctxForThread("t1")))._unsafeUnwrap();

        // The session owns the hash, thus an echo-back of this block can carry no stale value.
        expect(value).toEqual({ found: true, block: { kind: "table", id: "tb1", binding: { kind: "artifact-table", path } } });
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

describe("the call detail", () => {
    /** The tools of a bare gateway. Each hook is pure, thus no seeded state matters here. */
    const tools = createReportAuthoringTools(makeFakeGateway());

    /** Run a tool's call hook, asserting that the tool declares one. */
    function detailOf(tool: { describeCall?: (input: never) => string }, input: unknown): string {
        expect(tool.describeCall).toBeDefined();
        return tool.describeCall!(input as never);
    }

    /** A whole-table reference onto one pinned path. */
    function tableBinding(path: string): Record<string, unknown> {
        return { kind: "artifact-table", path, hash: "sha256:aaa" };
    }

    it("names the kind and the title of an added section", () => {
        expect(detailOf(tools.add_block, { block: { kind: "section", id: "s1", title: "Summary", blocks: [] } })).toBe('add section "Summary"');
    });

    it("names the file of an added table, chart, and figure", () => {
        expect(detailOf(tools.add_block, { block: { kind: "table", id: "b1", binding: tableBinding("runs/r1/s1/output/de.csv") } })).toBe("add table de.csv");
        expect(
            detailOf(tools.add_block, {
                block: { kind: "chart", id: "b2", binding: tableBinding("runs/r1/s1/output/de.csv"), chartType: "bar", encoding: { x: "gene" } },
            }),
        ).toBe("add chart de.csv");
        expect(
            detailOf(tools.add_block, {
                block: { kind: "figure", id: "b3", binding: { kind: "artifact-file", path: "runs/r1/s1/figures/volcano.png", hash: "sha256:bbb" } },
            }),
        ).toBe("add figure volcano.png");
    });

    it("names the first bound file of a claim, and skips a citation that names none", () => {
        const bindings = [
            { kind: "citation", idKind: "pmid", id: "12345", raw: "Watson 1953" },
            { kind: "artifact-value", path: "output/de.csv", hash: "sha256:aaa", locator: { column: "padj", row: 0 } },
        ];

        expect(detailOf(tools.add_block, { block: { kind: "claim", id: "c1", content: { prose: "x" }, bindings } })).toBe("add claim de.csv");
    });

    it("names the file of a metric, through a direct value and through a derivation", () => {
        const direct = { kind: "artifact-value", path: "output/counts.csv", hash: "sha256:aaa", locator: { column: "n", row: 0 } };
        const derived = {
            kind: "derivation",
            op: "ratio",
            inputs: [
                { kind: "artifact-value", path: "output/a.csv", hash: "sha256:aaa", locator: { column: "n", row: 0 } },
                { kind: "artifact-value", path: "output/b.csv", hash: "sha256:bbb", locator: { column: "n", row: 0 } },
            ],
        };

        expect(detailOf(tools.add_block, { block: { kind: "metric", id: "m1", label: "count", value: direct } })).toBe("add metric counts.csv");
        expect(detailOf(tools.add_block, { block: { kind: "metric", id: "m2", label: "ratio", value: derived } })).toBe("add metric a.csv");
    });

    it("gives the kind alone for a block that names no subject", () => {
        expect(detailOf(tools.add_block, { block: { kind: "text", id: "t1", content: { prose: "hello" } } })).toBe("add text");
        expect(detailOf(tools.add_block, { block: { kind: "section", id: "s1", title: "", blocks: [] } })).toBe("add section");
        expect(detailOf(tools.add_block, { block: { kind: "claim", id: "c1", content: { prose: "x" }, bindings: [{ kind: "citation", id: "1" }] } })).toBe(
            "add claim",
        );
    });

    it("gives a bare line for a payload that names no kind", () => {
        expect(detailOf(tools.add_block, { block: { id: "b1" } })).toBe("add a block");
        expect(detailOf(tools.add_block, { block: "not a block at all" })).toBe("add a block");
    });

    // A model routinely sends a nested object as a stringified payload, and the tool decodes it before
    // the core reads it. The detail decodes the same value, thus the two never disagree about the call.
    it("reads a double-encoded payload the same as a plain one", () => {
        const block = JSON.stringify({ kind: "table", id: "b1", binding: tableBinding("output/de.csv") });

        expect(detailOf(tools.add_block, { block })).toBe("add table de.csv");
    });

    // The emit-site cap cuts the tail. Left to it, a long title takes the whole line and the quote that
    // closes the mark goes with the cut. The hook bounds the title, thus the mark always closes.
    it("bounds a long section title, so the mark always closes", () => {
        const detail = detailOf(tools.add_block, { block: { kind: "section", id: "s1", title: "T".repeat(80), blocks: [] } });

        expect(detail).toBe(`add section "${"T".repeat(31)}…"`);
        expect(normalizeDetail(detail)).toBe(detail);
    });

    it("keeps the block id as the whole detail of each other mutation and of the read", () => {
        expect(detailOf(tools.change_block, { targetId: "b1" })).toBe("change b1");
        expect(detailOf(tools.move_block, { targetId: "b1", parentId: "s2" })).toBe("move b1");
        expect(detailOf(tools.remove_block, { targetId: "b1" })).toBe("remove b1");
        expect(detailOf(tools.read_block, { targetId: "b1" })).toBe("read b1");
        expect(detailOf(tools.set_title, { title: "Report" })).toBe("title the report Report");
    });
});

describe("the report observation", () => {
    /** A draft with two atoms under one section, thus a change, a move, and a remove each have a target. */
    function seededDraft(): DraftDocument {
        return {
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
        };
    }

    /** The tools over one seeded thread, with the gateway that holds the draft. */
    function seeded(deps?: ReportAuthoringToolDeps): { tools: ReportAuthoringTools; gateway: FakeGateway } {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: seededDraft(), snapshot });
        return { tools: deps === undefined ? createReportAuthoringTools(gateway) : createReportAuthoringTools(gateway, deps), gateway };
    }

    it("gives one event for each landed block operation, with the block id and the two identifiers", async () => {
        const events: ReportObservationEvent[] = [];
        const { tools } = seeded({ emitReportObservation: (event) => events.push(event) });
        const ctx = ctxForThread("t1");

        (await tools.add_block.execute({ block: { kind: "text", id: "t3", content: { prose: "c" } }, parentId: "s1" }, ctx))._unsafeUnwrap();
        (await tools.change_block.execute({ targetId: "t1", block: { kind: "text", id: "t1", content: { prose: "z" } } }, ctx))._unsafeUnwrap();
        (await tools.move_block.execute({ targetId: "t1", after: "t2" }, ctx))._unsafeUnwrap();
        (await tools.remove_block.execute({ targetId: "t1" }, ctx))._unsafeUnwrap();

        // The event names the block that the call changed, thus a consumer places each act with no read of
        // the draft.
        expect(events).toEqual([
            { type: "add-block", analysisId: DEFAULT_ANALYSIS_ID, threadId: "t1", blockId: "t3" },
            { type: "change-block", analysisId: DEFAULT_ANALYSIS_ID, threadId: "t1", blockId: "t1" },
            { type: "move-block", analysisId: DEFAULT_ANALYSIS_ID, threadId: "t1", blockId: "t1" },
            { type: "remove-block", analysisId: DEFAULT_ANALYSIS_ID, threadId: "t1", blockId: "t1" },
        ]);
    });

    it("targets the document with the title event, and that event names no block", async () => {
        const events: ReportObservationEvent[] = [];
        const { tools } = seeded({ emitReportObservation: (event) => events.push(event) });

        (await tools.set_title.execute({ title: "Differential expression" }, ctxForThread("t1")))._unsafeUnwrap();

        expect(events).toEqual([{ type: "set-title", analysisId: DEFAULT_ANALYSIS_ID, threadId: "t1", title: "Differential expression" }]);
        // The title sits on the document, thus the event carries no block id at all.
        expect(events[0]).not.toHaveProperty("blockId");
    });

    it("emits nothing for a refused operation and nothing for a failed persist", async () => {
        const events: ReportObservationEvent[] = [];
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: seededDraft(), snapshot });
        const tools = createReportAuthoringTools(gateway, { emitReportObservation: (event) => events.push(event) });
        const ctx = ctxForThread("t1");

        const refused = (await tools.remove_block.execute({ targetId: "no-such-block" }, ctx))._unsafeUnwrap();
        expect(refused.applied).toBe(false);

        // The core lands the title, and the persist then fails. Thus the row keeps the old draft.
        gateway.setPersistFault(true);
        const failed = (await tools.set_title.execute({ title: "Report" }, ctx))._unsafeUnwrap();
        expect(failed.applied).toBe(false);

        expect(events).toEqual([]);
    });

    it("lands the mutation the same way when the composition binds no seam", async () => {
        const { tools, gateway } = seeded();

        const value = (await tools.set_title.execute({ title: "Report" }, ctxForThread("t1")))._unsafeUnwrap();

        expect(value.applied).toBe(true);
        expect(gateway.peek("t1")!.document.title).toBe("Report");
    });

    it("logs a throw of the seam, and the mutation still lands", async () => {
        const logger = createCapturingLogger();
        const { tools, gateway } = seeded({
            emitReportObservation: () => {
                throw new Error("the recorder is down");
            },
            logger,
        });

        const value = (await tools.set_title.execute({ title: "Report" }, ctxForThread("t1")))._unsafeUnwrap();

        // The act landed before the emit, thus a defect of the host costs the event alone.
        expect(value.applied).toBe(true);
        expect(gateway.peek("t1")!.document.title).toBe("Report");
        const record = logger.records.find((held) => held.msg.includes("the report observation seam threw"));
        expect(record?.level).toBe("error");
        expect(record?.fields).toMatchObject({ analysisId: DEFAULT_ANALYSIS_ID, threadId: "t1", event: "set-title", err: "the recorder is down" });
    });
});
