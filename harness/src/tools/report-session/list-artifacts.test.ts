/**
 * The tests of the pinned-artifact listing tool.
 *
 * Each test drives the tool through `execute` with a temp directory as the workspace root and an
 * in-memory gateway. The tests cover the order of the listing, the columns of a CSV and of a TSV, the
 * absent file, the file type that holds no cell, and the session refusal.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Scope } from "../../auth/types.js";
import type { ReportSnapshot } from "../../report-model/reference-resolver.js";
import type { ReportSessionState, ReportSessionStateGateway, SessionStateLoad, SessionStatePersist, StampResult } from "../report-authoring/authoring-tools.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import type { ToolContext } from "../define-tool.js";
import { createListPinnedArtifactsTool } from "./list-artifacts.js";

/** Each root that a test made. The cleanup removes them after the suite. */
const roots: string[] = [];

afterAll(async () => {
    for (const root of roots) {
        await rm(root, { recursive: true, force: true });
    }
});

/** Make a fresh temp directory as a workspace root. */
async function makeRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "list-artifacts-"));
    roots.push(root);
    return root;
}

/** Write a file under the workspace root, and make each parent directory of it. */
async function writeUnder(root: string, path: string, content: string): Promise<void> {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
}

/** The default analysis of a seeded thread. It matches the scope of `ctxForThread`, thus a call resolves. */
const DEFAULT_ANALYSIS_ID = "analysis-001";

/** An empty draft. The listing reads the snapshot alone, thus the document never matters here. */
const emptyDraft = { title: "", sections: [] };

/** An in-memory gateway. It holds one state and one analysis for each thread. */
interface FakeGateway extends ReportSessionStateGateway {
    seed(threadId: string, snapshot: ReportSnapshot, analysisId?: string): void;
}

function makeFakeGateway(): FakeGateway {
    const rows = new Map<string, { state: ReportSessionState; analysisId: string }>();
    return {
        seed(threadId, snapshot, analysisId = DEFAULT_ANALYSIS_ID): void {
            rows.set(threadId, { state: { document: structuredClone(emptyDraft), snapshot: structuredClone(snapshot) }, analysisId });
        },
        load(threadId): Promise<SessionStateLoad> {
            const row = rows.get(threadId);
            if (row === undefined) {
                return Promise.resolve({ outcome: "absent" });
            }
            const state = structuredClone(row.state);
            return Promise.resolve({ outcome: "found", state, analysisId: row.analysisId, token: state.document, seenDocumentHash: null });
        },
        persist(): Promise<SessionStatePersist> {
            return Promise.resolve({ outcome: "persisted" });
        },
        stampRendered(): Promise<StampResult> {
            return Promise.resolve({ outcome: "stamped" });
        },
        stampSeen(): Promise<StampResult> {
            return Promise.resolve({ outcome: "stamped" });
        },
    };
}

/** A tool context whose scope names a report thread. */
function ctxForThread(threadId: string): ToolContext {
    const { ctx } = makeToolContext();
    const scope: Scope = { kind: "analysis", analysisId: DEFAULT_ANALYSIS_ID, threadId };
    return { ...ctx, session: { ...ctx.session, scope } };
}

describe("the listing order", () => {
    it("gives each pinned artifact in the code-unit order of the path", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", {
            artifacts: {
                "runs/r1/step-b/output/counts.csv": { hash: "sha256:bbb", fileType: "output" },
                "data/inputs/f1/raw.csv": { hash: "sha256:aaa", fileType: "output" },
                "runs/r1/figures/plot.png": { hash: "sha256:ccc", fileType: "figure" },
            },
        });
        const tool = createListPinnedArtifactsTool({ gateway, resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("listed");
        if (result.outcome === "listed") {
            expect(result.artifacts.map((artifact) => artifact.path)).toEqual([
                "data/inputs/f1/raw.csv",
                "runs/r1/figures/plot.png",
                "runs/r1/step-b/output/counts.csv",
            ]);
            expect(result.artifacts.map((artifact) => artifact.hash)).toEqual(["sha256:aaa", "sha256:ccc", "sha256:bbb"]);
            expect(result.artifacts.map((artifact) => artifact.fileType)).toEqual(["output", "figure", "output"]);
        }
    });
});

describe("the columns", () => {
    it("splits the header of a CSV on the comma, and trims each name", async () => {
        const root = await makeRoot();
        await writeUnder(root, "runs/r1/step-a/output/de.csv", "gene, padj ,log2fc\nTP53,0.01,2.5\n");
        const gateway = makeFakeGateway();
        gateway.seed("t1", { artifacts: { "runs/r1/step-a/output/de.csv": { hash: "sha256:aaa", fileType: "output" } } });
        const tool = createListPinnedArtifactsTool({ gateway, resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("listed");
        if (result.outcome === "listed") {
            expect(result.artifacts[0].columns).toEqual(["gene", "padj", "log2fc"]);
        }
    });

    it("splits the header of a TSV on the tab", async () => {
        const root = await makeRoot();
        await writeUnder(root, "runs/r1/step-a/output/de.tsv", "gene\tpadj\tlog2fc\nTP53\t0.01\t2.5\n");
        const gateway = makeFakeGateway();
        gateway.seed("t1", { artifacts: { "runs/r1/step-a/output/de.tsv": { hash: "sha256:aaa", fileType: "output" } } });
        const tool = createListPinnedArtifactsTool({ gateway, resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("listed");
        if (result.outcome === "listed") {
            expect(result.artifacts[0].columns).toEqual(["gene", "padj", "log2fc"]);
        }
    });

    it("gives no columns for a file whose bytes are absent from the disk", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { artifacts: { "runs/r1/step-a/output/gone.csv": { hash: "sha256:aaa", fileType: "output" } } });
        const tool = createListPinnedArtifactsTool({ gateway, resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        // The path and the hash still list, because the pin is the evidence and the header is orientation.
        expect(result.outcome).toBe("listed");
        if (result.outcome === "listed") {
            expect(result.artifacts).toHaveLength(1);
            expect(result.artifacts[0].hash).toBe("sha256:aaa");
            expect(result.artifacts[0].columns).toBeUndefined();
        }
    });

    it("reads no header for a file type that holds no cell", async () => {
        const root = await makeRoot();
        // The bytes are on disk and they hold a comma. A figure holds no cell, thus no read runs.
        await writeUnder(root, "runs/r1/figures/plot.png", "not,a,header\n");
        const gateway = makeFakeGateway();
        gateway.seed("t1", { artifacts: { "runs/r1/figures/plot.png": { hash: "sha256:ccc", fileType: "figure" } } });
        const tool = createListPinnedArtifactsTool({ gateway, resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("listed");
        if (result.outcome === "listed") {
            expect(result.artifacts[0].fileType).toBe("figure");
            expect(result.artifacts[0].columns).toBeUndefined();
        }
    });

    it("gives no columns for a path that escapes the workspace root", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        // The ledger accepts any path, thus a registered `../../` path is a legal snapshot key.
        gateway.seed("t1", { artifacts: { "../../escape.csv": { hash: "sha256:aaa", fileType: "output" } } });
        const tool = createListPinnedArtifactsTool({ gateway, resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("listed");
        if (result.outcome === "listed") {
            expect(result.artifacts[0].columns).toBeUndefined();
        }
    });

    it("gives no columns when the workspace root does not resolve, and it still lists each pin", async () => {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { artifacts: { "runs/r1/step-a/output/de.csv": { hash: "sha256:aaa", fileType: "output" } } });
        const tool = createListPinnedArtifactsTool({
            gateway,
            resolveWorkspaceRoot: () => {
                throw new Error("the workspace root did not resolve");
            },
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("listed");
        if (result.outcome === "listed") {
            expect(result.artifacts[0].hash).toBe("sha256:aaa");
            expect(result.artifacts[0].columns).toBeUndefined();
        }
    });
});

describe("the session refusal", () => {
    it("refuses a call whose scope carries no thread id", async () => {
        const root = await makeRoot();
        const tool = createListPinnedArtifactsTool({ gateway: makeFakeGateway(), resolveWorkspaceRoot: () => root });
        // The default fixture scope is an analysis scope with no thread id.
        const { ctx } = makeToolContext();

        const result = (await tool.execute({}, ctx))._unsafeUnwrap();

        expect(result.outcome).toBe("refused");
        if (result.outcome === "refused") {
            expect(result.refusal.reason).toBe("no-thread-scope");
        }
    });

    it("refuses a thread with no stored state", async () => {
        const root = await makeRoot();
        const tool = createListPinnedArtifactsTool({ gateway: makeFakeGateway(), resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("absent")))._unsafeUnwrap();

        expect(result.outcome).toBe("refused");
        if (result.outcome === "refused") {
            expect(result.refusal.reason).toBe("absent-state");
        }
    });
});
