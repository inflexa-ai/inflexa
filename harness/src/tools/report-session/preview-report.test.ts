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
import { UnavailablePreviewPublisher, type PreviewMintResult, type PreviewPublisher } from "../report/preview-publisher.js";
import type { ReportSessionState, ReportSessionStateGateway, SessionStateLoad, SessionStatePersist } from "../report-authoring/authoring-tools.js";
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

/**
 * An in-memory gateway. It holds one state for each thread, and the load clones each value to model a
 * durable round trip. A fault flag forces the failure outcome.
 */
interface FakeGateway extends ReportSessionStateGateway {
    seed(threadId: string, state: ReportSessionState): void;
    setFault(fault: boolean): void;
}

function makeFakeGateway(): FakeGateway {
    const rows = new Map<string, ReportSessionState>();
    let fault = false;
    return {
        seed(threadId, state): void {
            rows.set(threadId, structuredClone(state));
        },
        setFault(value): void {
            fault = value;
        },
        load(threadId): Promise<SessionStateLoad> {
            if (fault) {
                return Promise.resolve({ outcome: "failed", detail: "the store is down" });
            }
            const state = rows.get(threadId);
            return Promise.resolve(state === undefined ? { outcome: "absent" } : { outcome: "found", state: structuredClone(state) });
        },
        persist(threadId, document): Promise<SessionStatePersist> {
            const existing = rows.get(threadId);
            const snapshotOfThread = existing?.snapshot ?? { artifacts: {} };
            rows.set(threadId, { document: structuredClone(document), snapshot: snapshotOfThread });
            return Promise.resolve({ outcome: "persisted" });
        },
    };
}

/** A publisher that mints ok. It carries no page, thus it gives the hosted surface alone. */
class OkPublisher implements PreviewPublisher {
    async mintPreviewAccess(): Promise<PreviewMintResult> {
        return { ok: true, data: { baseUrl: "https://host/preview", token: "tok", expiresAt: "2030-01-01T00:00:00Z" } };
    }
}

/** A tool context whose scope names a report thread. */
function ctxForThread(threadId: string): ToolContext {
    const { ctx } = makeToolContext();
    const scope: Scope = { kind: "analysis", analysisId: "analysis-001", threadId };
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
            previews: new UnavailablePreviewPublisher(),
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
            previews: new UnavailablePreviewPublisher(),
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
            previews: new UnavailablePreviewPublisher(),
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

describe("the resolver absence", () => {
    it("names the resolver absence, and no page lands", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const tool = createPreviewReportTool({ gateway, previews: new UnavailablePreviewPublisher(), resolveWorkspaceRoot: () => root });

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
            previews: new UnavailablePreviewPublisher(),
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

describe("the publisher arm", () => {
    it("returns the page path when the publisher gives not-ok", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const tool = createPreviewReportTool({
            gateway,
            resolver: createFixtureResolver(),
            previews: new UnavailablePreviewPublisher(),
            resolveWorkspaceRoot: () => root,
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        if (result.outcome === "rendered") {
            expect(result.access.minted).toBe(false);
            if (!result.access.minted) {
                expect(result.access.detail.length).toBeGreaterThan(0);
            }
            expect(existsSync(result.pagePath)).toBe(true);
        }
        assertNoLegacyDirs(root);
    });

    it("carries the minted access when the publisher gives ok", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const tool = createPreviewReportTool({ gateway, resolver: createFixtureResolver(), previews: new OkPublisher(), resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        if (result.outcome === "rendered") {
            expect(result.access.minted).toBe(true);
            if (result.access.minted) {
                expect(result.access.baseUrl).toBe("https://host/preview");
                expect(result.access.token).toBe("tok");
                expect(result.access.expiresAt).toBe("2030-01-01T00:00:00Z");
            }
            expect(existsSync(result.pagePath)).toBe(true);
        }
        assertNoLegacyDirs(root);
    });
});

describe("the session refusal", () => {
    it("refuses a call whose scope carries no thread id", async () => {
        const root = await makeRoot();
        const tool = createPreviewReportTool({
            gateway: makeFakeGateway(),
            resolver: createFixtureResolver(),
            previews: new UnavailablePreviewPublisher(),
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
            previews: new UnavailablePreviewPublisher(),
            resolveWorkspaceRoot: () => root,
        });

        const result = (await tool.execute({}, ctxForThread("absent")))._unsafeUnwrap();

        expect(result.outcome).toBe("refused");
        if (result.outcome === "refused") {
            expect(result.refusal.reason).toBe("absent-state");
        }
    });
});
