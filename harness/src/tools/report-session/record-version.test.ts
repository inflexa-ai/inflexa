/**
 * The tests of the record tool, against the Postgres test schema.
 *
 * Each test drives the tool through `execute` with an in-memory gateway, the real version store, the real
 * thread store, and the fixture resolver. The gateway controls the seen hash, thus a test isolates the
 * look-before-record rule. The store is real, thus each test asserts the durable state and not a spy.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";

import type { Scope } from "../../auth/types.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import type { Logger } from "../../lib/logger.js";
import { createThreadStore, type ThreadStore } from "../../memory/thread-store.js";
import type { DraftDocument } from "../../report-model/draft.js";
import { computeDraftHash } from "../../report-model/draft-hash.js";
import { createFixtureResolver } from "../../report-model/fixture-resolver.js";
import type { ReportSnapshot } from "../../report-model/reference-resolver.js";
import { withSchema } from "../../__tests__/setup/postgres.js";
import { upsertAnalysis } from "../../state/analyses.js";
import type { DerivationRecord } from "../../state/report-session-state.js";
import { createReportVersionStore, type ReportVersionStore } from "../../state/report-versions.js";
import { reportSessionDerivedDir } from "../../workspace/paths.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import type { ToolContext } from "../define-tool.js";
import type { ReportSessionStateGateway, SessionStateLoad, SessionStatePersist, StampResult } from "../report-authoring/authoring-tools.js";
import { createPreviewReportTool } from "./preview-report.js";
import { createRecordVersionTool, type RecordVersionResult } from "./record-version.js";

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
                            ...(assertValue !== undefined ? { assert: { value: assertValue } } : {}),
                        },
                    },
                ],
            },
        ],
    };
}

/** The content hash that every derived table of these tests carries. */
const DERIVED_HASH = `sha256:${"b".repeat(64)}`;

/** One derivation record of a session. The output path is the workspace-relative path that the record holds. */
function derivation(outputPath: string): DerivationRecord {
    return {
        outputPath,
        outputHash: DERIVED_HASH,
        sources: [{ path: "data/x.csv", hash: "sha256:aaa" }],
        scriptHash: `sha256:${"c".repeat(64)}`,
        script: "import pandas",
    };
}

/** The path of one derived table of a thread, under the derived directory of its session. */
function derivedPath(threadId: string, name: string): string {
    return `${reportSessionDerivedDir(threadId)}/${name}`;
}

/** A snapshot that holds the metric artifact and each named derived table. */
function snapshotWithDerived(paths: readonly string[]): ReportSnapshot {
    const artifacts: ReportSnapshot["artifacts"] = { ...metricSnapshot.artifacts };
    for (const path of paths) {
        artifacts[path] = { hash: DERIVED_HASH, rows: [{ gene: "TP53", padj: 0.004 }] };
    }
    return { artifacts };
}

/** A valid draft with the metric of `metricDoc` and one table that binds the given derived path. */
function docWithTable(path: string): DraftDocument {
    const draft = metricDoc();
    draft.sections[0].blocks.push({ kind: "table", id: "tb1", binding: { kind: "artifact-table", path, hash: DERIVED_HASH } });
    return draft;
}

/** Write one file under a workspace root, and make each directory over it. */
async function stageFile(root: string, path: string): Promise<string> {
    const absolute = join(root, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, "gene,padj\nTP53,0.004\n", "utf8");
    return absolute;
}

/** A logger that keeps each warn message, thus a test reads the one record of a failed prune. */
function recordingLogger(): { logger: Logger; warns: string[] } {
    const warns: string[] = [];
    const logger: Logger = {
        ...createNoopLogger(),
        warn: (msg) => {
            warns.push(msg);
        },
        with: () => logger,
        named: () => logger,
    };
    return { logger, warns };
}

/** A gateway whose load gives the one thread its state, the seen hash, and the derivations that a test decides. */
function gatewayFor(
    threadId: string,
    document: DraftDocument,
    snapshot: ReportSnapshot,
    seen: string | null,
    derivations: readonly DerivationRecord[] = [],
): ReportSessionStateGateway {
    const stamped = (): Promise<StampResult> => Promise.resolve({ outcome: "stamped" });
    return {
        load: (t): Promise<SessionStateLoad> =>
            Promise.resolve(
                t === threadId
                    ? { outcome: "found", state: { document, snapshot }, analysisId: ANALYSIS_ID, token: null, seenDocumentHash: seen, derivations }
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
    /** The workspace root of the suite. The prune resolves the derived directory of a session under it. */
    let suiteRoot: string;

    beforeAll(async () => {
        const ctx = await withSchema("record_report_version");
        pool = ctx.pool;
        drop = ctx.drop;
        store = createReportVersionStore({ pool });
        threads = createThreadStore(pool);
        (await upsertAnalysis(pool, ANALYSIS_ID, null))._unsafeUnwrap();
        suiteRoot = await makeRoot("record-suite-");
    });

    afterAll(async () => {
        for (const root of createdRoots) {
            await rm(root, { recursive: true, force: true });
        }
        await drop();
    });

    function makeTool(gateway: ReportSessionStateGateway, root?: string, logger?: Logger) {
        return createRecordVersionTool({
            gateway,
            store,
            threads,
            resolveWorkspaceRoot: () => root ?? suiteRoot,
            makeResolver: () => createFixtureResolver(),
            ...(logger ? { logger } : {}),
        });
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
        const tool = createRecordVersionTool({ gateway, store, threads, resolveWorkspaceRoot: () => suiteRoot, makeResolver });

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
            resolveWorkspaceRoot: () => suiteRoot,
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

    describe("the derivation prune", () => {
        /** Anchor one report thread and its parent conversation, thus the record reaches the store. */
        async function anchorThread(threadId: string, parentId: string): Promise<void> {
            (await threads.createThread({ threadId: parentId, analysisId: ANALYSIS_ID }))._unsafeUnwrap();
            (await threads.createThread({ threadId, analysisId: ANALYSIS_ID, type: "report", parentThreadId: parentId, parentSeq: 1 }))._unsafeUnwrap();
        }

        it("removes the unused output, keeps the used one, and keeps both records", async () => {
            const threadId = "thread-prune";
            await anchorThread(threadId, "parent-prune");
            const root = await makeRoot("record-prune-");

            const used = derivedPath(threadId, "used.csv");
            const unused = derivedPath(threadId, "unused.csv");
            const usedFile = await stageFile(root, used);
            const unusedFile = await stageFile(root, unused);

            const doc = docWithTable(used);
            const records = [derivation(used), derivation(unused)];
            const gateway = gatewayFor(threadId, doc, snapshotWithDerived([used, unused]), computeDraftHash(doc), records);

            const result = (await makeTool(gateway, root).execute({}, ctxForThread(threadId)))._unsafeUnwrap();

            expect(result.outcome).toBe("recorded");
            // A binding names the used path, thus its bytes stay. No binding names the other, thus its file
            // goes and the disk of the session holds the closure of the recorded report.
            expect(existsSync(usedFile)).toBe(true);
            expect(existsSync(unusedFile)).toBe(false);
            // The records are append-only. The bytes are reproducible from the script and the sources, thus
            // the prune touches no record.
            expect(records.map((record) => record.outputPath)).toEqual([used, unused]);
        });

        it("keeps the version and logs when a removal fails", async () => {
            const threadId = "thread-prune-fault";
            await anchorThread(threadId, "parent-prune-fault");
            const root = await makeRoot("record-prune-fault-");

            const unused = derivedPath(threadId, "unused.csv");
            // A directory at the output name refuses a plain file removal, thus the removal throws and the
            // prune reports one failure.
            await mkdir(join(root, unused, "inner"), { recursive: true });

            const doc = metricDoc();
            const { logger, warns } = recordingLogger();
            const gateway = gatewayFor(threadId, doc, metricSnapshot, computeDraftHash(doc), [derivation(unused)]);

            const result = (await makeTool(gateway, root, logger).execute({}, ctxForThread(threadId)))._unsafeUnwrap();

            // The prune runs after the version lands, thus a failed removal costs the cleanup alone.
            expect(result.outcome).toBe("recorded");
            expect((await store.getThreadVersion(threadId))._unsafeUnwrap()).not.toBeNull();
            expect(warns).toContain("an unused derivation did not go");
        });

        it("removes no file that sits outside the derived directory of the session", async () => {
            const threadId = "thread-prune-escape";
            await anchorThread(threadId, "parent-prune-escape");
            const parent = await makeRoot("record-prune-escape-");
            const root = join(parent, "workspace");
            await mkdir(root, { recursive: true });

            // One record names a run output inside the tree, and one climbs out of the tree. The prune owns
            // the derived directory alone, thus it removes neither.
            const inTree = "runs/r1/output/stray.csv";
            const outOfTree = "../escape.csv";
            const inTreeFile = await stageFile(root, inTree);
            const outOfTreeFile = await stageFile(parent, "escape.csv");

            const doc = metricDoc();
            const { logger, warns } = recordingLogger();
            const gateway = gatewayFor(threadId, doc, metricSnapshot, computeDraftHash(doc), [derivation(inTree), derivation(outOfTree)]);

            const result = (await makeTool(gateway, root, logger).execute({}, ctxForThread(threadId)))._unsafeUnwrap();

            expect(result.outcome).toBe("recorded");
            expect(existsSync(inTreeFile)).toBe(true);
            expect(existsSync(outOfTreeFile)).toBe(true);
            expect(warns.filter((line) => line === "an unused derivation sits outside the derived directory of the session").length).toBe(2);
        });

        it("prunes nothing for a session that derived nothing", async () => {
            const threadId = "thread-prune-none";
            await anchorThread(threadId, "parent-prune-none");
            const root = await makeRoot("record-prune-none-");

            // A file under the derived directory that no record names stays, because the prune reads the
            // records and never the directory.
            const stray = await stageFile(root, derivedPath(threadId, "stray.csv"));

            const doc = metricDoc();
            const gateway = gatewayFor(threadId, doc, metricSnapshot, computeDraftHash(doc));

            const result = (await makeTool(gateway, root).execute({}, ctxForThread(threadId)))._unsafeUnwrap();

            expect(result.outcome).toBe("recorded");
            expect(existsSync(stray)).toBe(true);
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
            return resolver;
        };

        const root = await makeRoot("record-shared-");

        const previewTool = createPreviewReportTool({ gateway, makeResolver, resolveWorkspaceRoot: () => root });
        const preview = (await previewTool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();
        expect(preview.outcome).toBe("rendered");

        const recordTool = createRecordVersionTool({ gateway, store, threads, resolveWorkspaceRoot: () => root, makeResolver });
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
