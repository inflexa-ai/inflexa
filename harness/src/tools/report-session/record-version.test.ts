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

import type { Scope } from "../../auth/types.js";
import { createThreadStore, type ThreadStore } from "../../memory/thread-store.js";
import type { DraftDocument } from "../../report-model/draft.js";
import { computeDraftHash } from "../../report-model/draft-hash.js";
import { createFixtureResolver } from "../../report-model/fixture-resolver.js";
import type { ReportSnapshot } from "../../report-model/reference-resolver.js";
import { withSchema } from "../../__tests__/setup/postgres.js";
import { upsertAnalysis } from "../../state/analyses.js";
import { createReportVersionStore, type ReportVersionStore } from "../../state/report-versions.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import type { ToolContext } from "../define-tool.js";
import type { ReportSessionStateGateway, SessionStateLoad, SessionStatePersist, StampResult } from "../report-authoring/authoring-tools.js";
import { createPreviewReportTool } from "./preview-report.js";
import { createRecordVersionTool, type RecordVersionResult } from "./record-version.js";

const ANALYSIS_ID = "analysis-001";

/** Each workspace root that a test made. The cleanup removes them after the suite. */
const createdRoots: string[] = [];

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
                            ...(assertValue !== undefined ? { assert: { value: assertValue } } : {}),
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

    function makeTool(gateway: ReportSessionStateGateway) {
        return createRecordVersionTool({ gateway, store, threads, makeResolver: () => createFixtureResolver() });
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
            return createFixtureResolver();
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
                throw new Error("the workspace root did not resolve");
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
        }

        // The store holds one version, and it carries the anchor from the thread row.
        const stored = (await store.getThreadVersion(threadId))._unsafeUnwrap();
        expect(stored).not.toBeNull();
        expect(stored!.versionId).toBe(versionId!);
        expect(stored!.parentThreadId).toBe(parentId);
        expect(stored!.parentSeq).toBe(7);
        expect(stored!.document.title).toBe("Report");
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
            return resolver;
        };

        const root = await mkdtemp(join(tmpdir(), "record-shared-"));
        createdRoots.push(root);

        const previewTool = createPreviewReportTool({ gateway, makeResolver, resolveWorkspaceRoot: () => root });
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
        const block = stored!.document.sections[0].blocks[0];
        expect(block.kind).toBe("metric");
        if (block.kind === "metric") {
            const resolved = (await resolver.resolve(block.value, metricSnapshot))._unsafeUnwrap();
            expect(resolved).toEqual({ type: "scalar", value: 42 });
        }
    });

    describe("the result detail", () => {
        /** Run the tool's result hook, asserting that the tool declares one. */
        function detailOf(tool: ReturnType<typeof createRecordVersionTool>, result: RecordVersionResult): string {
            expect(tool.describeResult).toBeDefined();
            return tool.describeResult!({}, result);
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

        it("names the outcome kind of a gate that refused", async () => {
            const threadId = "thread-detail-never-seen";
            const tool = makeTool(gatewayFor(threadId, metricDoc(), metricSnapshot, null));

            const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

            expect(detailOf(tool, result)).toBe("never-seen");
        });
    });
});
