/**
 * The tests of the record tool, against the Postgres test schema.
 *
 * Each test drives the tool through `execute` with an in-memory gateway, the real version store, the real
 * thread store, and the fixture resolver. The gateway controls the seen hash, thus a test isolates the
 * look-before-record rule. The store is real, thus each test asserts the durable state and not a spy.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
import { createRecordVersionTool } from "./record-version.js";

const ANALYSIS_ID = "analysis-001";

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
        (await upsertAnalysis(pool, ANALYSIS_ID, null, null))._unsafeUnwrap();
    });

    afterAll(async () => {
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
});
