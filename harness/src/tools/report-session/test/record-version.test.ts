/**
 * The tests of the record tool, against the Postgres test schema.
 *
 * Each test drives the tool through `execute` with an in-memory gateway, the real version store, the real
 * thread store, and the fixture resolver. The gateway controls the seen hash, thus a test isolates the
 * look-before-record rule. The store is real, thus each test asserts the durable state and not a spy.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";

import type { Scope } from "../../../auth/types.js";
import type { Logger } from "../../../lib/logger.js";
import { createThreadStore, type ThreadStore } from "../../../memory/thread-store.js";
import type { DraftDocument } from "../../../report-model/draft.js";
import { computeDraftHash } from "../../../report-model/draft-hash.js";
import { createFixtureResolver } from "../../../report-model/fixture-resolver.js";
import type { ReportSnapshot } from "../../../report-model/reference-resolver.js";
import { createCapturingLogger } from "../../../__tests__/setup/logger.js";
import { withSchema } from "../../../__tests__/setup/postgres.js";
import { upsertAnalysis } from "../../../state/analyses.js";
import { createReportVersionStore, type ReportVersionStore } from "../../../state/report-versions.js";
import { makeToolContext } from "../../__fixtures__/tool-context.js";
import type { ToolContext } from "../../define-tool.js";
import type { ReportSessionStateGateway, SessionStateLoad, SessionStatePersist, StampResult } from "../../report-authoring/authoring-tools.js";
import type { ProvenanceSeam, SessionProvenanceEvent } from "../../../provenance/seam.js";
import { createPreviewReportTool } from "../preview-report.js";
import { createRecordVersionTool, type RecordVersionResult } from "../record-version.js";

const ANALYSIS_ID = "analysis-001";

/** Each workspace root that a test made. The cleanup removes them after the suite. */
const createdRoots: string[] = [];

/** Make one temp directory as a workspace root, and register it for the cleanup. */
async function makeRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    createdRoots.push(root);
    return root;
}

/** A snapshot with one readable artifact that the metric binds to. */
const metricSnapshot: ReportSnapshot = { artifacts: { "data/x.csv": { hash: "sha256:aaa", rows: [{ n: 42 }] } } };

/** A valid draft with one metric that resolves to the scalar 42. An assert value forces a value-tier failure. */
function metricDoc(assertValue?: number): DraftDocument {
    return {
        title: "Report",
        sections: [
            {
                kind: "section",
                id: "s1",
                title: "Intro",
                blocks: [
                    {
                        kind: "metric",
                        id: "m1",
                        label: "count",
                        value: {
                            kind: "artifact-value",
                            path: "data/x.csv",
                            hash: "sha256:aaa",
                            locator: { column: "n", row: 0 },
                            assert: assertValue === undefined ? undefined : { value: assertValue },
                        },
                    },
                ],
            },
        ],
    };
}

/** A gateway whose load gives the one thread its state and the seen hash that a test decides. */
function gatewayFor(threadId: string, document: DraftDocument, snapshot: ReportSnapshot, seen: string | null): ReportSessionStateGateway {
    const stamped = (): Promise<StampResult> => Promise.resolve({ outcome: "stamped" });
    return {
        load: (t): Promise<SessionStateLoad> =>
            Promise.resolve(
                t === threadId
                    ? { outcome: "found", state: { document, snapshot }, analysisId: ANALYSIS_ID, token: null, seenDocumentHash: seen }
                    : { outcome: "absent" },
            ),
        persist: (): Promise<SessionStatePersist> => Promise.resolve({ outcome: "persisted" }),
        stampRendered: stamped,
        stampSeen: stamped,
    };
}

/**
 * A session whose draft a test amends between two records.
 *
 * The load reads the draft of the moment, thus the second record sees what the amend left. `amend` swaps the
 * draft alone, the same as the durable row: a persist of a document touches no hash column, thus the seen
 * hash stays on the page of the last look. `look` copies the hash of the current draft onto the seen hash,
 * the same as the eyes tool after a capture.
 */
function mutableSession(
    threadId: string,
    document: DraftDocument,
    snapshot: ReportSnapshot,
): { gateway: ReportSessionStateGateway; amend: (next: DraftDocument) => void; look: () => void } {
    let draft = document;
    let seen = computeDraftHash(document);
    const stamped = (): Promise<StampResult> => Promise.resolve({ outcome: "stamped" });
    const gateway: ReportSessionStateGateway = {
        load: (t): Promise<SessionStateLoad> =>
            Promise.resolve(
                t === threadId
                    ? { outcome: "found", state: { document: draft, snapshot }, analysisId: ANALYSIS_ID, token: null, seenDocumentHash: seen }
                    : { outcome: "absent" },
            ),
        persist: (): Promise<SessionStatePersist> => Promise.resolve({ outcome: "persisted" }),
        stampRendered: stamped,
        stampSeen: stamped,
    };
    return {
        gateway,
        amend: (next: DraftDocument): void => {
            draft = next;
        },
        look: (): void => {
            seen = computeDraftHash(draft);
        },
    };
}

/** A tool context whose scope names a report thread. */
function ctxForThread(threadId: string): ToolContext {
    const { ctx } = makeToolContext();
    const scope: Scope = { kind: "analysis", analysisId: ANALYSIS_ID, threadId };
    return { ...ctx, session: { ...ctx.session, scope } };
}

describe("createRecordVersionTool", () => {
    let pool: Pool;
    let drop: () => Promise<void>;
    let store: ReportVersionStore;
    let threads: ThreadStore;

    beforeAll(async () => {
        const ctx = await withSchema("record_report_version");
        pool = ctx.pool;
        drop = ctx.drop;
        store = createReportVersionStore({ pool });
        threads = createThreadStore(pool);
        (await upsertAnalysis(pool, ANALYSIS_ID, null))._unsafeUnwrap();
    });

    afterAll(async () => {
        for (const root of createdRoots) {
            await rm(root, { recursive: true, force: true });
        }
        await drop();
    });

    function makeTool(gateway: ReportSessionStateGateway, logger?: Logger, emitSessionEvent?: ProvenanceSeam["emitSessionEvent"]) {
        return createRecordVersionTool({
            gateway,
            store,
            threads,
            makeResolver: () => Promise.resolve(createFixtureResolver()),
            logger,
            provenance: { emitSessionEvent },
        });
    }

    /** Anchor one report thread and its parent conversation, thus the record reaches the store. */
    async function anchorThread(threadId: string, parentId: string): Promise<void> {
        (await threads.createThread({ threadId: parentId, analysisId: ANALYSIS_ID }))._unsafeUnwrap();
        (await threads.createThread({ threadId, analysisId: ANALYSIS_ID, type: "report", parentThreadId: parentId, parentSeq: 1 }))._unsafeUnwrap();
    }

    it("records nothing and names the block when an assert fails", async () => {
        const threadId = "thread-invalid";
        const doc = metricDoc(999);
        const tool = makeTool(gatewayFor(threadId, doc, metricSnapshot, computeDraftHash(doc)));

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("invalid");
        if (result.outcome === "invalid") {
            expect(result.resolutionFailures?.map((failure) => failure.blockId)).toEqual(["m1"]);
        }
        // The gate refused before the store, thus the thread holds no version.
        expect((await store.getThreadVersion(threadId))._unsafeUnwrap()).toBeNull();
    });

    it("carries the advisory warnings of the finish on the gap list", async () => {
        const threadId = "thread-gaps-warnings";
        // The draft has no title, thus the finish gives a gap. The prose types a number, thus it warns too.
        const doc: DraftDocument = {
            title: "",
            sections: [{ kind: "section", id: "s1", title: "Intro", blocks: [{ kind: "text", id: "t1", content: { prose: "The cohort holds 48 samples." } }] }],
        };
        const tool = makeTool(gatewayFor(threadId, doc, metricSnapshot, computeDraftHash(doc)));

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("gaps");
        if (result.outcome === "gaps") {
            expect(result.warnings).toEqual([{ blockId: "t1", kind: "free-numeral", detail: "48" }]);
        }
        expect((await store.getThreadVersion(threadId))._unsafeUnwrap()).toBeNull();
    });

    it("refuses a never-seen page, and records nothing", async () => {
        const threadId = "thread-never-seen";
        const tool = makeTool(gatewayFor(threadId, metricDoc(), metricSnapshot, null));

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("never-seen");
        expect((await store.getThreadVersion(threadId))._unsafeUnwrap()).toBeNull();
    });

    it("refuses a stale look, and records nothing", async () => {
        const threadId = "thread-stale";
        // The seen hash names an earlier draft, thus it does not equal the hash of the current draft.
        const tool = makeTool(gatewayFor(threadId, metricDoc(), metricSnapshot, "an-earlier-hash"));

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("stale-look");
        expect((await store.getThreadVersion(threadId))._unsafeUnwrap()).toBeNull();
    });

    it("makes no resolver for a never-seen page", async () => {
        const threadId = "thread-order-never-seen";
        const gateway = gatewayFor(threadId, metricDoc(), metricSnapshot, null);
        // The counting factory proves that the look refuses before the resolver constructs.
        let constructions = 0;
        const makeResolver = () => {
            constructions += 1;
            return Promise.resolve(createFixtureResolver());
        };
        const tool = createRecordVersionTool({ gateway, store, threads, makeResolver });

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("never-seen");
        // The never-seen look refuses before the expensive validation, thus no resolver constructs.
        expect(constructions).toBe(0);
        expect((await store.getThreadVersion(threadId))._unsafeUnwrap()).toBeNull();
    });

    it("names the unresolvable root when the resolver construction throws after a clean look", async () => {
        const threadId = "thread-root-unresolvable";
        const doc = metricDoc();
        const gateway = gatewayFor(threadId, doc, metricSnapshot, computeDraftHash(doc));
        // The clean look holds, thus the record reaches the resolver construction, which throws on an
        // unresolvable root.
        const tool = createRecordVersionTool({
            gateway,
            store,
            threads,
            makeResolver: () => {
                return Promise.reject(new Error("the workspace root did not resolve"));
            },
        });

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("root-unresolvable");
        if (result.outcome === "root-unresolvable") {
            expect(result.detail).toContain("workspace root");
        }
        expect((await store.getThreadVersion(threadId))._unsafeUnwrap()).toBeNull();
    });

    it("records one version and returns its id after a clean look", async () => {
        const parentId = "parent-conv";
        const threadId = "thread-record";
        (await threads.createThread({ threadId: parentId, analysisId: ANALYSIS_ID }))._unsafeUnwrap();
        (await threads.createThread({ threadId, analysisId: ANALYSIS_ID, type: "report", parentThreadId: parentId, parentSeq: 7 }))._unsafeUnwrap();

        const doc = metricDoc();
        const tool = makeTool(gatewayFor(threadId, doc, metricSnapshot, computeDraftHash(doc)));

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("recorded");
        let versionId: string | undefined;
        if (result.outcome === "recorded") {
            versionId = result.versionId;
            expect(versionId).toBeTruthy();
            // The metric carries no prose, thus the finish warns about nothing.
            expect(result.warnings).toEqual([]);
        }
        if (versionId === undefined) throw new Error("the recorded version id is absent");

        // The store holds one version, and it carries the anchor from the thread row.
        const stored = (await store.getThreadVersion(threadId))._unsafeUnwrap();
        expect(stored).not.toBeNull();
        expect(stored?.versionId).toBe(versionId);
        expect(stored?.parentThreadId).toBe(parentId);
        expect(stored?.parentSeq).toBe(7);
        expect(stored?.document.title).toBe("Report");
    });

    it("gives a rerun of the call in a durable step the same version, and the rerun does not read as a replacement", async () => {
        const threadId = "thread-record-rerun";
        await anchorThread(threadId, "parent-record-rerun");
        const doc = metricDoc();
        const tool = createRecordVersionTool({
            gateway: gatewayFor(threadId, doc, metricSnapshot, computeDraftHash(doc)),
            store,
            threads,
            makeResolver: () => Promise.resolve(createFixtureResolver()),
            stepKey: () => "wf-record:8",
        });

        const first = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();
        const second = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(first).toMatchObject({ outcome: "recorded", replaced: false });
        expect(second).toEqual(first);
        const { rows } = await pool.query<{ n: number }>({
            text: "SELECT COUNT(*)::int AS n FROM cortex_report_versions WHERE thread_id = $1",
            values: [threadId],
        });
        expect(rows).toEqual([{ n: 1 }]);
    });

    describe("the record loop", () => {
        /** The draft of `metricDoc`, under a title that a test tells from the first one. */
        function amendedDoc(title: string, assertValue?: number): DraftDocument {
            const draft = metricDoc(assertValue);
            draft.title = title;
            return draft;
        }

        it("replaces the one version on a record that follows an amend", async () => {
            const threadId = "thread-rerecord";
            await anchorThread(threadId, "parent-rerecord");
            const session = mutableSession(threadId, metricDoc(), metricSnapshot);
            const tool = makeTool(session.gateway);

            const first = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();
            expect(first.outcome).toBe("recorded");

            session.amend(amendedDoc("An amended report"));
            session.look();
            const second = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

            expect(second.outcome).toBe("recorded");
            if (first.outcome === "recorded" && second.outcome === "recorded") {
                // The later record writes over the one version, thus the id that the first record gave
                // still names the version that stands.
                expect(second.versionId).toBe(first.versionId);
                expect(first.replaced).toBe(false);
                expect(second.replaced).toBe(true);
            }

            const stored = (await store.getThreadVersion(threadId))._unsafeUnwrap();
            expect(stored?.document.title).toBe("An amended report");
        });

        it("keeps the stored version when a later record fails its gate", async () => {
            const threadId = "thread-rerecord-invalid";
            await anchorThread(threadId, "parent-rerecord-invalid");
            const session = mutableSession(threadId, metricDoc(), metricSnapshot);
            const tool = makeTool(session.gateway);

            const first = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();
            expect(first.outcome).toBe("recorded");

            // The amend breaks the assert of the metric, and the eyes look at the broken page.
            session.amend(amendedDoc("A broken report", 999));
            session.look();
            const second = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

            expect(second.outcome).toBe("invalid");
            // The gate refused before the store, thus the earlier record still stands whole.
            const stored = (await store.getThreadVersion(threadId))._unsafeUnwrap();
            expect(stored?.document.title).toBe("Report");
            if (first.outcome === "recorded") {
                expect(stored?.versionId).toBe(first.versionId);
            }
        });

        it("refuses a later record whose look is stale, and keeps the stored version", async () => {
            const threadId = "thread-rerecord-stale";
            await anchorThread(threadId, "parent-rerecord-stale");
            const session = mutableSession(threadId, metricDoc(), metricSnapshot);
            const tool = makeTool(session.gateway);

            expect((await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap().outcome).toBe("recorded");

            // The amend runs, and no look follows it. The seen hash names the page of the record, thus it
            // does not name the amended draft.
            session.amend(amendedDoc("An unseen report"));
            const second = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

            expect(second.outcome).toBe("stale-look");
            const stored = (await store.getThreadVersion(threadId))._unsafeUnwrap();
            expect(stored?.document.title).toBe("Report");
        });
    });

    it("serves the preview and the record gate through one resolver factory on the same reference", async () => {
        const parentId = "parent-shared";
        const threadId = "thread-shared";
        (await threads.createThread({ threadId: parentId, analysisId: ANALYSIS_ID }))._unsafeUnwrap();
        (await threads.createThread({ threadId, analysisId: ANALYSIS_ID, type: "report", parentThreadId: parentId, parentSeq: 3 }))._unsafeUnwrap();

        const doc = metricDoc();
        const gateway = gatewayFor(threadId, doc, metricSnapshot, computeDraftHash(doc));

        // The one factory serves both tools. It counts how many times a tool builds the resolver, and it
        // gives one fixture realization.
        const resolver = createFixtureResolver();
        let constructions = 0;
        const makeResolver = () => {
            constructions += 1;
            return Promise.resolve(resolver);
        };

        const root = await makeRoot("record-shared-");

        const previewTool = createPreviewReportTool({ gateway, makeResolver, resolveWorkspaceRoot: () => Promise.resolve(root) });
        const preview = (await previewTool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();
        expect(preview.outcome).toBe("rendered");

        const recordTool = createRecordVersionTool({ gateway, store, threads, makeResolver });
        const record = (await recordTool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();
        expect(record.outcome).toBe("recorded");

        // Both tools built the resolver through the one factory.
        expect(constructions).toBe(2);

        // The page shows the resolved metric, and the recorded version binds the reference that gives it.
        if (preview.outcome === "rendered") {
            const page = await readFile(preview.pagePath, "utf8");
            expect(page).toContain("42");
        }
        const stored = (await store.getThreadVersion(threadId))._unsafeUnwrap();
        if (stored === null) throw new Error("the thread holds no recorded version");
        const section = stored.document.sections[0];
        if (section === undefined) throw new Error("the recorded version holds no section");
        const block = section.blocks[0];
        if (block === undefined) throw new Error("the recorded section holds no block");
        expect(block.kind).toBe("metric");
        if (block.kind === "metric") {
            const resolved = (await resolver.resolve(block.value, metricSnapshot))._unsafeUnwrap();
            expect(resolved).toEqual({ type: "scalar", value: 42 });
        }
    });

    describe("the result detail", () => {
        /** Run the tool's result hook, asserting that the tool declares one. */
        function detailOf(tool: ReturnType<typeof createRecordVersionTool>, result: RecordVersionResult): string | undefined {
            expect(typeof tool.describeResult).toBe("function");
            const describeResult = tool.describeResult?.bind(tool);
            if (describeResult === undefined) throw new Error("the tool declares no result detail");
            return describeResult({}, result);
        }

        it("names the version that landed", async () => {
            const parentId = "parent-detail";
            const threadId = "thread-detail";
            (await threads.createThread({ threadId: parentId, analysisId: ANALYSIS_ID }))._unsafeUnwrap();
            (await threads.createThread({ threadId, analysisId: ANALYSIS_ID, type: "report", parentThreadId: parentId, parentSeq: 1 }))._unsafeUnwrap();
            const doc = metricDoc();
            const tool = makeTool(gatewayFor(threadId, doc, metricSnapshot, computeDraftHash(doc)));

            const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

            expect(result.outcome).toBe("recorded");
            if (result.outcome === "recorded") {
                expect(detailOf(tool, result)).toBe(`version ${result.versionId}`);
            }
        });

        it("names the update on a record that replaced the version", async () => {
            const threadId = "thread-detail-update";
            await anchorThread(threadId, "parent-detail-update");
            const session = mutableSession(threadId, metricDoc(), metricSnapshot);
            const tool = makeTool(session.gateway);

            expect((await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap().outcome).toBe("recorded");

            const amended = metricDoc();
            amended.title = "An amended report";
            session.amend(amended);
            session.look();
            const second = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

            // The line reads as an update, thus a watcher does not read the later record as a refusal.
            expect(detailOf(tool, second)).toBe("version updated");
        });

        it("names the outcome kind of a gate that refused", async () => {
            const threadId = "thread-detail-never-seen";
            const tool = makeTool(gatewayFor(threadId, metricDoc(), metricSnapshot, null));

            const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

            expect(detailOf(tool, result)).toBe("never-seen");
        });
    });

    describe("the report observation", () => {
        it("gives one event for the version that landed, and it marks the record that replaced it", async () => {
            const threadId = "thread-observed";
            await anchorThread(threadId, "parent-observed");
            const events: SessionProvenanceEvent[] = [];
            const session = mutableSession(threadId, metricDoc(), metricSnapshot);
            const tool = makeTool(session.gateway, undefined, (event) => events.push(event));

            const first = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();
            const amended = metricDoc();
            amended.title = "An amended report";
            session.amend(amended);
            session.look();
            const second = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

            expect(first.outcome).toBe("recorded");
            expect(second.outcome).toBe("recorded");
            if (first.outcome !== "recorded") throw new Error("expected a recorded version");
            // The thread holds one version, thus the second event names the same id and it marks the
            // replacement.
            expect(events).toEqual([
                { type: "record-version", analysisId: ANALYSIS_ID, threadId, versionId: first.versionId, replaced: false },
                { type: "record-version", analysisId: ANALYSIS_ID, threadId, versionId: first.versionId, replaced: true },
            ]);
        });

        it("emits nothing when the look-before-record rule refuses", async () => {
            const threadId = "thread-observed-never-seen";
            const events: SessionProvenanceEvent[] = [];
            const tool = makeTool(gatewayFor(threadId, metricDoc(), metricSnapshot, null), undefined, (event) => events.push(event));

            expect((await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap().outcome).toBe("never-seen");
            expect(events).toEqual([]);
        });

        it("logs a throw of the seam, and the version still stands", async () => {
            const threadId = "thread-observed-throws";
            await anchorThread(threadId, "parent-observed-throws");
            const logger = createCapturingLogger();
            const doc = metricDoc();
            const tool = makeTool(gatewayFor(threadId, doc, metricSnapshot, computeDraftHash(doc)), logger, () => {
                throw new Error("the recorder is down");
            });

            const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

            // The version stands before the emit, thus a defect of the host costs the event alone.
            expect(result.outcome).toBe("recorded");
            expect((await store.getThreadVersion(threadId))._unsafeUnwrap()).not.toBeNull();
            const record = logger.records.find((held) => held.msg.includes("the session emit of the provenance seam threw"));
            expect(record?.level).toBe("error");
            expect(record?.fields).toMatchObject({ analysisId: ANALYSIS_ID, threadId, event: "record-version", err: "the recorder is down" });
        });
    });
});
