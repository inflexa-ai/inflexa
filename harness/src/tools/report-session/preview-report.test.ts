/**
 * The tests of the render-and-preview tool.
 *
 * Each test drives the tool through `execute` with a temp directory as the workspace root, an in-memory
 * gateway, and the fixture resolver. The render, the bridge, and the resolver have their own tests, thus
 * these tests cover the tool orchestration: the gap return, the pass path, the staged asset, each absence,
 * and each publisher arm.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Scope } from "../../auth/types.js";
import type { DraftDocument } from "../../report-model/draft.js";
import { createFixtureResolver } from "../../report-model/fixture-resolver.js";
import type { ReportSnapshot } from "../../report-model/reference-resolver.js";
import type { ReportSessionState, ReportSessionStateGateway, SessionStateLoad, SessionStatePersist, StampResult } from "../report-authoring/authoring-tools.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import type { ToolContext } from "../define-tool.js";
import { createPreviewReportTool } from "./preview-report.js";

/** Each root that a test made. The cleanup removes them after the suite. */
const roots: string[] = [];

afterAll(async () => {
    for (const root of roots) {
        await rm(root, { recursive: true, force: true });
    }
});

/** Make a fresh temp directory as a workspace root. */
async function makeRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "preview-report-"));
    roots.push(root);
    return root;
}

/** The default analysis of a seeded thread. It matches the scope of `ctxForThread`, thus a call resolves. */
const DEFAULT_ANALYSIS_ID = "analysis-001";

/**
 * An in-memory gateway. It holds one state and one analysis for each thread, and the load clones each value
 * to model a durable round trip. The found load carries the stored analysis and the prior document as the
 * concurrency token. A fault flag forces the failure outcome.
 */
interface FakeGateway extends ReportSessionStateGateway {
    seed(threadId: string, state: ReportSessionState, analysisId?: string): void;
    setFault(fault: boolean): void;
}

interface FakeRow {
    state: ReportSessionState;
    analysisId: string;
    rendered: string | null;
    seen: string | null;
}

function makeFakeGateway(): FakeGateway {
    const rows = new Map<string, FakeRow>();
    let fault = false;
    return {
        seed(threadId, state, analysisId = DEFAULT_ANALYSIS_ID): void {
            rows.set(threadId, { state: structuredClone(state), analysisId, rendered: null, seen: null });
        },
        setFault(value): void {
            fault = value;
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
            return Promise.resolve({ outcome: "found", state, analysisId: row.analysisId, token: state.document, seenDocumentHash: row.seen });
        },
        persist(threadId, document): Promise<SessionStatePersist> {
            const existing = rows.get(threadId);
            const snapshotOfThread = existing?.state.snapshot ?? { artifacts: {} };
            const analysisId = existing?.analysisId ?? DEFAULT_ANALYSIS_ID;
            rows.set(threadId, {
                state: { document: structuredClone(document), snapshot: snapshotOfThread },
                analysisId,
                rendered: existing?.rendered ?? null,
                seen: existing?.seen ?? null,
            });
            return Promise.resolve({ outcome: "persisted" });
        },
        stampRendered(threadId, hash): Promise<StampResult> {
            const row = rows.get(threadId);
            if (row === undefined) {
                return Promise.resolve({ outcome: "absent" });
            }
            row.rendered = hash;
            return Promise.resolve({ outcome: "stamped" });
        },
        stampSeen(threadId): Promise<StampResult> {
            const row = rows.get(threadId);
            if (row === undefined) {
                return Promise.resolve({ outcome: "absent" });
            }
            row.seen = row.rendered;
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

/** A snapshot with one readable artifact that a metric binds to. */
const metricSnapshot: ReportSnapshot = { artifacts: { "data/x.csv": { hash: "sha256:aaa", rows: [{ n: 42 }] } } };

/** A valid draft with one metric that resolves to the scalar 42. */
function metricDoc(): DraftDocument {
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
                        value: { kind: "artifact-value", path: "data/x.csv", hash: "sha256:aaa", locator: { column: "n", row: 0 } },
                    },
                ],
            },
        ],
    };
}

/** No write of the new path lands under the old namespaces. */
function assertNoLegacyDirs(root: string): void {
    expect(existsSync(join(root, "previews"))).toBe(false);
    expect(existsSync(join(root, "reports"))).toBe(false);
}

describe("the gap return", () => {
    it("gives the gap list for an empty draft, and no page lands", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: { title: "", sections: [] }, snapshot: { artifacts: {} } });
        const tool = createPreviewReportTool({
            gateway,
            resolver: createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("gaps");
        if (result.outcome === "gaps") {
            expect(result.gaps.length).toBeGreaterThan(0);
        }
        expect(existsSync(join(root, "report-sessions"))).toBe(false);
        assertNoLegacyDirs(root);
    });
});

describe("the pass path", () => {
    it("renders the page to disk, and the result carries its path", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const tool = createPreviewReportTool({
            gateway,
            resolver: createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        if (result.outcome === "rendered") {
            expect(result.pagePath).toBe(join(root, "report-sessions", "t1", "index.html"));
            expect(existsSync(result.pagePath)).toBe(true);
            const content = await readFile(result.pagePath, "utf8");
            expect(content).toContain("42");
        }
        assertNoLegacyDirs(root);
    });
});

describe("the staged asset", () => {
    it("stages the bound image under assets/, and the page holds the relative src", async () => {
        const root = await makeRoot();
        await mkdir(join(root, "runs/r1/figures"), { recursive: true });
        await writeFile(join(root, "runs/r1/figures/plot.png"), "PNGDATA");
        const snapshot: ReportSnapshot = { artifacts: { "runs/r1/figures/plot.png": { hash: "sha256:bbb", fileType: "figure" } } };
        const document: DraftDocument = {
            title: "Figures",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: "Plots",
                    blocks: [
                        {
                            kind: "figure",
                            id: "f1",
                            binding: { kind: "artifact-file", path: "runs/r1/figures/plot.png", hash: "sha256:bbb" },
                            caption: "A plot",
                        },
                    ],
                },
            ],
        };
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document, snapshot });
        const tool = createPreviewReportTool({
            gateway,
            resolver: createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        if (result.outcome === "rendered") {
            const stagedFile = join(root, "report-sessions", "t1", "assets", "sha256-bbb.png");
            expect(existsSync(stagedFile)).toBe(true);
            const content = await readFile(result.pagePath, "utf8");
            expect(content).toContain("assets/sha256-bbb.png");
        }
        assertNoLegacyDirs(root);
    });
});

describe("the figure containment", () => {
    it("refuses a bound figure whose source escapes the workspace root, names the block, and no page lands", async () => {
        const root = await makeRoot();
        // The ledger accepts any path, thus a registered `../../` path is a legal snapshot key. The
        // structural tier admits it, and the containment test at staging refuses the escape.
        const escapePath = "../../escape.png";
        const snapshot: ReportSnapshot = { artifacts: { [escapePath]: { hash: "sha256:bbb", fileType: "figure" } } };
        const document: DraftDocument = {
            title: "Figures",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: "Plots",
                    blocks: [{ kind: "figure", id: "f1", binding: { kind: "artifact-file", path: escapePath, hash: "sha256:bbb" }, caption: "A plot" }],
                },
            ],
        };
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document, snapshot });
        const tool = createPreviewReportTool({
            gateway,
            resolver: createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("figure-out-of-scope");
        if (result.outcome === "figure-out-of-scope") {
            expect(result.blockId).toBe("f1");
            expect(result.path).toBe(escapePath);
        }
        expect(existsSync(join(root, "report-sessions"))).toBe(false);
        assertNoLegacyDirs(root);
    });
});

describe("the resolver absence", () => {
    it("names the resolver absence, and no page lands", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const tool = createPreviewReportTool({ gateway, resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("resolver-unavailable");
        expect(existsSync(join(root, "report-sessions"))).toBe(false);
        assertNoLegacyDirs(root);
    });
});

describe("the unresolved reference", () => {
    it("names each unresolved reference with its block id, and no page lands", async () => {
        const root = await makeRoot();
        // The artifact exists with a matching hash, thus the structural tier passes. It holds no row, thus
        // the value tier cannot address the cell and the reference is unresolved.
        const snapshot: ReportSnapshot = { artifacts: { "data/x.csv": { hash: "sha256:aaa", rows: [] } } };
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot });
        const tool = createPreviewReportTool({
            gateway,
            resolver: createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("unresolved-references");
        if (result.outcome === "unresolved-references") {
            expect(result.unresolved.map((entry) => entry.blockId)).toEqual(["m1"]);
        }
        expect(existsSync(join(root, "report-sessions"))).toBe(false);
        assertNoLegacyDirs(root);
    });
});

describe("the session refusal", () => {
    it("refuses a call whose scope carries no thread id", async () => {
        const root = await makeRoot();
        const tool = createPreviewReportTool({
            gateway: makeFakeGateway(),
            resolver: createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
        });
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
        const tool = createPreviewReportTool({
            gateway: makeFakeGateway(),
            resolver: createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
        });

        const result = (await tool.execute({}, ctxForThread("absent")))._unsafeUnwrap();

        expect(result.outcome).toBe("refused");
        if (result.outcome === "refused") {
            expect(result.refusal.reason).toBe("absent-state");
        }
    });

    it("refuses a scope whose analysis differs from the analysis that owns the thread", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        // The thread belongs to a different analysis than the scope of the call.
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot }, "analysis-999");
        const tool = createPreviewReportTool({ gateway, resolver: createFixtureResolver(), resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("refused");
        if (result.outcome === "refused") {
            expect(result.refusal.reason).toBe("scope-analysis-mismatch");
            expect(result.refusal.detail).toContain("analysis-001");
            expect(result.refusal.detail).toContain("analysis-999");
        }
        // The mismatch refuses before any resolution, thus no page lands.
        expect(existsSync(join(root, "report-sessions"))).toBe(false);
    });
});
