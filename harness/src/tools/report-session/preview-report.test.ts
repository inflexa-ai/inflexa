/**
 * The tests of the render-and-preview tool.
 *
 * Each test drives the tool through `execute` with a temp directory as the workspace root, an in-memory
 * gateway, and the fixture resolver. The render, the bridge, and the resolver have their own tests, thus
 * these tests cover the tool orchestration: the gap return, the pass path, the staged asset, each absence,
 * and each publisher arm.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuthContext, Scope } from "../../auth/types.js";
import type { DraftDocument } from "../../report-model/draft.js";
import { computeDraftHash } from "../../report-model/draft-hash.js";
import { createFixtureResolver } from "../../report-model/fixture-resolver.js";
import type { ReportSnapshot } from "../../report-model/reference-resolver.js";
import { DEPS_DIR, derivationScriptName, PAGE_ASSETS, tableSidecarName } from "../../report-render/assets.js";
import type { DerivationRecord } from "../../state/report-session-state.js";
import type { ReportSessionState, ReportSessionStateGateway, SessionStateLoad, SessionStatePersist, StampResult } from "../report-authoring/authoring-tools.js";
import { createCapturingLogger } from "../../__tests__/setup/logger.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import type { ToolContext } from "../define-tool.js";
import type { ProvenanceSeam, SessionProvenanceEvent } from "../../provenance/seam.js";
import { createPreviewReportTool, type PreviewReportResult } from "./preview-report.js";
import { UnavailableSessionPagePublisher, type SessionPagePublisher } from "./session-page-publisher.js";

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
    /** Seed the derivation ledger of a thread. A thread with no seed carries an empty ledger. */
    seedDerivations(threadId: string, derivations: readonly DerivationRecord[]): void;
    setFault(fault: boolean): void;
    /** The hash that the last `stampRendered` wrote for the thread, or `null` when no stamp landed. */
    renderedHash(threadId: string): string | null;
}

interface FakeRow {
    state: ReportSessionState;
    analysisId: string;
    rendered: string | null;
    seen: string | null;
    derivations: readonly DerivationRecord[];
}

function makeFakeGateway(): FakeGateway {
    const rows = new Map<string, FakeRow>();
    let fault = false;
    return {
        seed(threadId, state, analysisId = DEFAULT_ANALYSIS_ID): void {
            rows.set(threadId, { state: structuredClone(state), analysisId, rendered: null, seen: null, derivations: [] });
        },
        seedDerivations(threadId, derivations): void {
            const row = rows.get(threadId);
            if (row !== undefined) {
                rows.set(threadId, { ...row, derivations });
            }
        },
        setFault(value): void {
            fault = value;
        },
        renderedHash(threadId): string | null {
            return rows.get(threadId)?.rendered ?? null;
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
            return Promise.resolve({
                outcome: "found",
                state,
                analysisId: row.analysisId,
                token: state.document,
                seenDocumentHash: row.seen,
                derivations: row.derivations,
            });
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
                derivations: existing?.derivations ?? [],
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

/** A tool context whose scope names a report thread, beside the events that its emit recorded. */
function ctxWithEmitted(threadId: string): { ctx: ToolContext; emitted: unknown[] } {
    const { ctx, emitted } = makeToolContext();
    const scope: Scope = { kind: "analysis", analysisId: DEFAULT_ANALYSIS_ID, threadId };
    return { ctx: { ...ctx, session: { ...ctx.session, scope } }, emitted };
}

/** A tool context whose scope names a report thread. */
function ctxForThread(threadId: string): ToolContext {
    return ctxWithEmitted(threadId).ctx;
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
            makeResolver: () => createFixtureResolver(),
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
            makeResolver: () => createFixtureResolver(),
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

    it("stages every manifest asset beside the page", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        // The page names the chart runtime and each font under the sibling directory. A missing entry is a
        // failed request at view time, thus each manifest entry must be a real file beside the page.
        const assetsDir = join(root, "report-sessions", "t1", "assets");
        const absent = PAGE_ASSETS.filter((asset) => !existsSync(join(assetsDir, asset.file))).map((asset) => asset.file);
        expect(absent).toEqual([]);
        expect(PAGE_ASSETS.length).toBeGreaterThan(0);
    });

    it("groups each manifest static under the deps directory, and keeps the report-side files at the root", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        // The shipped libraries and fonts sit in one directory of their own, thus a reader of the directory
        // tells them from the files that the report produced.
        const assetsDir = join(root, "report-sessions", "t1", "assets");
        const inDeps = await readdir(join(assetsDir, DEPS_DIR));
        expect(inDeps.sort()).toEqual(PAGE_ASSETS.map((asset) => asset.file.slice(DEPS_DIR.length + 1)).sort());
        expect(await readdir(assetsDir)).toEqual([DEPS_DIR]);
    });

    it("stages the bytes that the injected asset lookup names", async () => {
        const root = await makeRoot();
        // An embedder that ships the asset bytes packed materializes them to disk and binds its own lookup.
        // The temp file stands for one materialized asset, thus each staged manifest entry holds its bytes.
        const packedDir = await makeRoot();
        const packed = join(packedDir, "packed-asset.bin");
        await writeFile(packed, "PACKED-ASSET-BYTES");
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
            resolvePageAsset: () => packed,
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        const assetsDir = join(root, "report-sessions", "t1", "assets");
        const staged = await Promise.all(PAGE_ASSETS.map((asset) => readFile(join(assetsDir, asset.file), "utf8")));
        expect(staged).toEqual(PAGE_ASSETS.map(() => "PACKED-ASSET-BYTES"));
    });

    it("emits one data-report-rendered part when the page lands", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
        });
        const { ctx, emitted } = ctxWithEmitted("t1");

        const result = (await tool.execute({}, ctx))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        expect(emitted).toHaveLength(1);
        const part = emitted[0] as { type: string; data: { id: string; renderedAt: string; title: string } };
        expect(part.type).toBe("data-report-rendered");
        expect(part.data.title).toBe("Report");
        // The id is one UUID per emission, and the timestamp is a valid ISO instant.
        expect(part.data.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(new Date(part.data.renderedAt).toISOString()).toBe(part.data.renderedAt);
    });

    it("emits nothing on the gap arm", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: { title: "", sections: [] }, snapshot: { artifacts: {} } });
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
        });
        const { ctx, emitted } = ctxWithEmitted("t1");

        const result = (await tool.execute({}, ctx))._unsafeUnwrap();

        expect(result.outcome).toBe("gaps");
        expect(emitted).toEqual([]);
    });
});

describe("the derivation records of the session", () => {
    const DERIVED = "report-sessions/t1/derived/merged.csv";
    const DERIVED_HASH = `sha256:${"d".repeat(64)}`;

    /** One derivation record of the session, over two sources and one script. */
    const record: DerivationRecord = {
        outputPath: DERIVED,
        outputHash: DERIVED_HASH,
        sources: [
            { path: "data/x.csv", hash: `sha256:${"a".repeat(64)}` },
            { path: "data/y.csv", hash: `sha256:${"b".repeat(64)}` },
        ],
        scriptHash: `sha256:${"c".repeat(64)}`,
        script: "import pandas",
    };

    /** A draft whose one table block binds the derived path. */
    function derivedDoc(): DraftDocument {
        return {
            title: "Report",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: "Intro",
                    blocks: [{ kind: "table", id: "tb1", binding: { kind: "artifact-table", path: DERIVED, hash: DERIVED_HASH } }],
                },
            ],
        };
    }

    /** The served membership: the pinned artifacts, with the derived table as one more entry. */
    const derivedSnapshot: ReportSnapshot = {
        artifacts: {
            "data/x.csv": { hash: "sha256:aaa", rows: [{ n: 42 }] },
            [DERIVED]: { hash: DERIVED_HASH, rows: [{ gene: "TP53", padj: 0.004 }] },
        },
    };

    it("states the chain of the derived path in the appendix of the page", async () => {
        const root = await makeRoot();
        // The card of a table offers its pinned bytes as a download, thus the stage copies the derived file.
        await mkdir(join(root, "report-sessions", "t1", "derived"), { recursive: true });
        await writeFile(join(root, DERIVED), "gene,padj\nTP53,0.004\n", "utf8");
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: derivedDoc(), snapshot: derivedSnapshot });
        gateway.seedDerivations("t1", [record]);
        const tool = createPreviewReportTool({ gateway, makeResolver: () => createFixtureResolver(), resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        if (result.outcome === "rendered") {
            const page = await readFile(result.pagePath, "utf8");
            // The tool passes the records of the session state to the render, thus the appendix entry of the
            // derived path names its sources and its script.
            expect(page).toContain(`<div class="report-ref-chain">`);
            expect(page).toContain("data/y.csv");
            expect(page).toContain(`<code class="report-ref-hash">${"c".repeat(12)}</code>`);
        }
    });

    it("stages the script of the referenced derivation, and the chain links it beside the derived file", async () => {
        const root = await makeRoot();
        await mkdir(join(root, "report-sessions", "t1", "derived"), { recursive: true });
        await writeFile(join(root, DERIVED), "gene,padj\nTP53,0.004\n", "utf8");
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: derivedDoc(), snapshot: derivedSnapshot });
        gateway.seedDerivations("t1", [record]);
        const tool = createPreviewReportTool({ gateway, makeResolver: () => createFixtureResolver(), resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        if (result.outcome === "rendered") {
            // The script text of the record lands under its content-addressed name, thus a reader opens the
            // script that made the table from the page itself.
            const script = derivationScriptName(record.scriptHash);
            const assetsDir = join(root, "report-sessions", "t1", "assets");
            expect(await readFile(join(assetsDir, script), "utf8")).toBe(record.script);

            // The derived file already sits in the session directory, thus the chain links it in place.
            const page = await readFile(result.pagePath, "utf8");
            expect(page).toContain(`href="assets/${script}"`);
            expect(page).toContain(`href="derived/merged.csv"`);
        }
    });

    it("removes the script of a derivation that the amended document no longer binds", async () => {
        const root = await makeRoot();
        await mkdir(join(root, "report-sessions", "t1", "derived"), { recursive: true });
        await writeFile(join(root, DERIVED), "gene,padj\nTP53,0.004\n", "utf8");
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: derivedDoc(), snapshot: derivedSnapshot });
        gateway.seedDerivations("t1", [record]);
        const tool = createPreviewReportTool({ gateway, makeResolver: () => createFixtureResolver(), resolveWorkspaceRoot: () => root });
        const assetsDir = join(root, "report-sessions", "t1", "assets");
        const script = derivationScriptName(record.scriptHash);

        const first = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();
        expect(first.outcome).toBe("rendered");
        expect(await readdir(assetsDir)).toContain(script);

        // The block that bound the derived path goes. The record stays in the durable state, and the page
        // states no chain for it, thus the script of that record leaves the directory.
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        gateway.seedDerivations("t1", [record]);
        const second = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(second.outcome).toBe("rendered");
        const afterSecond = await readdir(assetsDir);
        expect(afterSecond).not.toContain(script);
        expect(afterSecond).toContain(DEPS_DIR);
        if (second.outcome === "rendered") {
            expect(await readFile(second.pagePath, "utf8")).not.toContain(`<div class="report-ref-chain">`);
        }
    });

    it("renders no chain line for a session that derived nothing", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const tool = createPreviewReportTool({ gateway, makeResolver: () => createFixtureResolver(), resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        if (result.outcome === "rendered") {
            const page = await readFile(result.pagePath, "utf8");
            expect(page).not.toContain(`<div class="report-ref-chain">`);
        }
    });
});

describe("the rendered stamp", () => {
    it("stamps the hash of the draft that rendered", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        const draft = metricDoc();
        gateway.seed("t1", { document: draft, snapshot: metricSnapshot });
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        // The stamp holds the hash of the draft that the finish read, thus the record gate compares against it.
        expect(gateway.renderedHash("t1")).toBe(computeDraftHash(draft));
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
            makeResolver: () => createFixtureResolver(),
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

describe("the staged table data", () => {
    const TABLE_PATH = "runs/r1/output/de.csv";
    const TABLE_HASH = "sha256:ccc";
    const TABLE_CSV = "gene,direction\nTP53,up\nMYC,down\nEGFR,up\n";

    /** A snapshot whose one artifact is the table that the card binds. The fixture reads its rows. */
    function tableSnapshot(): ReportSnapshot {
        return {
            artifacts: {
                [TABLE_PATH]: {
                    hash: TABLE_HASH,
                    fileType: "output",
                    rows: [
                        { gene: "TP53", direction: "up" },
                        { gene: "MYC", direction: "down" },
                        { gene: "EGFR", direction: "up" },
                    ],
                },
            },
        };
    }

    /** A draft of one table block, with an optional second block that a later preview drops. */
    function tableDoc(extra?: DraftDocument["sections"][number]["blocks"][number]): DraftDocument {
        return {
            title: "Tables",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: "Results",
                    blocks: [
                        { kind: "table", id: "tbl", binding: { kind: "artifact-table", path: TABLE_PATH, hash: TABLE_HASH } },
                        ...(extra === undefined ? [] : [extra]),
                    ],
                },
            ],
        };
    }

    /** Write the artifact that the sidecar copies, under the workspace root. */
    async function seedTable(root: string): Promise<void> {
        await mkdir(join(root, "runs/r1/output"), { recursive: true });
        await writeFile(join(root, TABLE_PATH), TABLE_CSV);
    }

    it("stages the data asset and the raw sidecar, and the page references both", async () => {
        const root = await makeRoot();
        await seedTable(root);
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: tableDoc(), snapshot: tableSnapshot() });
        const tool = createPreviewReportTool({ gateway, makeResolver: () => createFixtureResolver(), resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        if (result.outcome === "rendered") {
            const assetsDir = join(root, "report-sessions", "t1", "assets");
            const staged = await readdir(assetsDir);
            const dataAsset = staged.find((name) => name.endsWith(".data.js"));
            const sidecar = tableSidecarName(TABLE_HASH, TABLE_PATH);

            expect(dataAsset).toBeDefined();
            // The sidecar is the pinned bytes themselves, thus the reader downloads the file and never a
            // re-serialization of it.
            expect(await readFile(join(assetsDir, sidecar), "utf8")).toBe(TABLE_CSV);
            expect(await readFile(join(assetsDir, dataAsset!), "utf8")).toContain("TP53");

            const page = await readFile(result.pagePath, "utf8");
            expect(page).toContain(`assets/${dataAsset!}`);
            expect(page).toContain(`assets/${sidecar}`);
        }
        assertNoLegacyDirs(root);
    });

    it("removes what the new page does not reference, and keeps each manifest static", async () => {
        const root = await makeRoot();
        await seedTable(root);
        await mkdir(join(root, "runs/r1/figures"), { recursive: true });
        await writeFile(join(root, "runs/r1/figures/plot.png"), "PNGDATA");
        const snapshot = tableSnapshot();
        snapshot.artifacts["runs/r1/figures/plot.png"] = { hash: "sha256:bbb", fileType: "figure" };
        const gateway = makeFakeGateway();
        const figure = {
            kind: "figure" as const,
            id: "f1",
            binding: { kind: "artifact-file" as const, path: "runs/r1/figures/plot.png", hash: "sha256:bbb" },
            caption: "A plot",
        };
        gateway.seed("t1", { document: tableDoc(figure), snapshot });
        const tool = createPreviewReportTool({ gateway, makeResolver: () => createFixtureResolver(), resolveWorkspaceRoot: () => root });
        const assetsDir = join(root, "report-sessions", "t1", "assets");

        const first = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();
        expect(first.outcome).toBe("rendered");
        const afterFirst = await readdir(assetsDir);
        expect(afterFirst).toContain("sha256-bbb.png");

        // A stale file of an earlier preview, and the block that produced the figure, both go.
        await writeFile(join(assetsDir, "t-000000000000.data.js"), "stale");
        gateway.seed("t1", { document: tableDoc(), snapshot });
        const second = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();
        expect(second.outcome).toBe("rendered");

        const afterSecond = await readdir(assetsDir);
        expect(afterSecond).not.toContain("sha256-bbb.png");
        expect(afterSecond).not.toContain("t-000000000000.data.js");
        expect(afterSecond.filter((name) => name.endsWith(".data.js")).length).toBe(1);
        expect(afterSecond).toContain(tableSidecarName(TABLE_HASH, TABLE_PATH));
        // The manifest governs the deps directory, thus the sweep of the page closure passes over it whole.
        const inDeps = await readdir(join(assetsDir, DEPS_DIR));
        for (const asset of PAGE_ASSETS) {
            expect(inDeps).toContain(asset.file.slice(DEPS_DIR.length + 1));
        }
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
            makeResolver: () => createFixtureResolver(),
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

describe("the unresolvable root", () => {
    it("names the unresolvable root when the resolver construction throws, and no page lands", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        // The resolver construction resolves the workspace root inside, and an unresolvable root throws.
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => {
                throw new Error("the workspace root did not resolve");
            },
            resolveWorkspaceRoot: () => root,
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("root-unresolvable");
        if (result.outcome === "root-unresolvable") {
            expect(result.detail).toContain("workspace root");
        }
        // The construction refuses before any write, thus no page lands.
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
            makeResolver: () => createFixtureResolver(),
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

describe("the slots of a chart", () => {
    const CHART_PATH = "runs/r1/output/km.csv";
    const TRACK_PATH = "runs/r1/output/domains.csv";
    const STATS_PATH = "runs/r1/output/logrank.csv";
    const HASH = "sha256:ddd";

    /** A snapshot of the curve, the track table, and the statistics table. */
    const slotSnapshot: ReportSnapshot = {
        artifacts: {
            [CHART_PATH]: { hash: HASH, fileType: "output", rows: [{ time: 0, survival: 1, arm: "A" }] },
            [TRACK_PATH]: { hash: HASH, fileType: "output", rows: [{ start: 1, end: 90, domain: "PWWP" }] },
            [STATS_PATH]: { hash: HASH, fileType: "output", rows: [{ pvalue: 0.0013 }] },
        },
    };

    /** A draft of one survival chart with one statistic at the given row, and a track where the draft asks for one. */
    function slotDoc(statisticRow: number, withTrack: boolean): DraftDocument {
        return {
            title: "Survival",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: "Survival",
                    blocks: [
                        {
                            kind: "chart",
                            id: "km1",
                            binding: { kind: "artifact-table", path: CHART_PATH, hash: HASH },
                            chartType: "km",
                            encoding: { x: "time", y: "survival", group: "arm" },
                            ...(withTrack
                                ? { track: { binding: { kind: "artifact-table", path: TRACK_PATH, hash: HASH }, start: "start", end: "end", label: "domain" } }
                                : {}),
                            statistics: [
                                {
                                    label: "Log-rank p",
                                    value: { kind: "artifact-value", path: STATS_PATH, hash: HASH, locator: { column: "pvalue", row: statisticRow } },
                                },
                            ],
                        },
                    ],
                },
            ],
        };
    }

    it("names the block and the slot of a statistic that does not resolve, and no page lands", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: slotDoc(5, true), snapshot: slotSnapshot });
        const tool = createPreviewReportTool({ gateway, makeResolver: () => createFixtureResolver(), resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("unresolved-references");
        if (result.outcome === "unresolved-references") {
            expect(result.unresolved.map((entry) => [entry.blockId, entry.slot, entry.failure.reason])).toEqual([
                ["km1", "statistic:0", "locator-out-of-range"],
            ]);
        }
        expect(existsSync(join(root, "report-sessions"))).toBe(false);
    });

    it("resolves and bridges the statistic, and the page prints it in the number format of its column as a power of ten", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: slotDoc(0, false), snapshot: slotSnapshot });
        const tool = createPreviewReportTool({ gateway, makeResolver: () => createFixtureResolver(), resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        if (result.outcome === "rendered") {
            const content = await readFile(result.pagePath, "utf8");
            expect(content).toContain("Log-rank p = 1.3 × 10⁻³");
        }
    });
});

describe("the track of a chart", () => {
    const CHART_PATH = "runs/r1/output/lollipop_DNMT3A.csv";
    const TRACK_PATH = "runs/r1/output/domains_DNMT3A.csv";
    const HASH = "sha256:eee";

    /** A snapshot of the mutations of one gene and of its domain table. */
    const trackSnapshot: ReportSnapshot = {
        artifacts: {
            [CHART_PATH]: {
                hash: HASH,
                fileType: "output",
                rows: [
                    { aa_position: 882, protein_change: "p.R882H", variant_classification: "Missense_Mutation", count: 19 },
                    { aa_position: 320, protein_change: "p.R320*", variant_classification: "Nonsense_Mutation", count: 1 },
                ],
            },
            [TRACK_PATH]: { hash: HASH, fileType: "output", rows: [{ start: 634, end: 912, name: "SAM-dependent MTase C5-type", protein_length: 912 }] },
        },
    };

    /** A draft of one lollipop over the mutations, with the domains as its track. */
    function trackDoc(): DraftDocument {
        return {
            title: "Mutations",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: "DNMT3A",
                    blocks: [
                        {
                            kind: "chart",
                            id: "lolli",
                            binding: { kind: "artifact-table", path: CHART_PATH, hash: HASH },
                            chartType: "lollipop",
                            encoding: { x: "aa_position", y: "count", group: "variant_classification", label: "protein_change" },
                            track: {
                                binding: { kind: "artifact-table", path: TRACK_PATH, hash: HASH },
                                start: "start",
                                end: "end",
                                label: "name",
                                length: "protein_length",
                            },
                        },
                    ],
                },
            ],
        };
    }

    it("resolves the track through the fixture resolver, and the page draws its domains under the axis", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: trackDoc(), snapshot: trackSnapshot });
        const tool = createPreviewReportTool({ gateway, makeResolver: () => createFixtureResolver(), resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        if (result.outcome === "rendered") {
            const content = await readFile(result.pagePath, "utf8");
            // The domain box and the protein length come from the track table alone.
            expect(content).toContain('"name":"SAM-dependent MTase C5-type"');
            expect(content).toContain('"max":912');
            // The appendix lists the binding and the track.
            expect(content).toContain(CHART_PATH);
            expect(content).toContain(TRACK_PATH);
        }
    });
});

describe("the trees of a heatmap", () => {
    const CHART_PATH = "runs/r1/output/heatmap_top_genes.csv";
    const GENE_TREE = "runs/r1/output/gene_tree.csv";
    const SAMPLE_TREE = "runs/r1/output/sample_tree.csv";
    const HASH = "sha256:fff";

    /** Two genes over three samples, the gene tree, and the sample tree. */
    const treeSnapshot: ReportSnapshot = {
        artifacts: {
            [CHART_PATH]: {
                hash: HASH,
                fileType: "output",
                rows: [
                    { gene: "Kal1", sample: "treated1", z: -1.2 },
                    { gene: "Kal1", sample: "untreated1", z: 0.8 },
                    { gene: "Kal1", sample: "untreated2", z: 0.7 },
                    { gene: "Treh", sample: "treated1", z: 1.1 },
                    { gene: "Treh", sample: "untreated1", z: -0.6 },
                    { gene: "Treh", sample: "untreated2", z: -0.7 },
                ],
            },
            [GENE_TREE]: {
                hash: HASH,
                fileType: "output",
                rows: [
                    { parent: "g_root", child: "Treh", height: 3.4 },
                    { parent: "g_root", child: "Kal1", height: 3.4 },
                ],
            },
            [SAMPLE_TREE]: {
                hash: HASH,
                fileType: "output",
                rows: [
                    { parent: "s_root", child: "treated1", height: 2.5 },
                    { parent: "s_root", child: "s_untreated", height: 2.5 },
                    { parent: "s_untreated", child: "untreated2", height: 0.3 },
                    { parent: "s_untreated", child: "untreated1", height: 0.3 },
                ],
            },
        },
    };

    /** A draft of one heatmap with a tree on each axis, whose gene tree names the given height column. */
    function treeDoc(geneHeight = "height"): DraftDocument {
        const tree = (path: string, height: string) => ({
            binding: { kind: "artifact-table" as const, path, hash: HASH },
            parent: "parent",
            child: "child",
            height,
        });
        return {
            title: "Expression",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: "Top genes",
                    blocks: [
                        {
                            kind: "chart",
                            id: "hm",
                            binding: { kind: "artifact-table", path: CHART_PATH, hash: HASH },
                            chartType: "heatmap",
                            encoding: { x: "sample", y: "gene", value: "z" },
                            trees: { x: tree(SAMPLE_TREE, "height"), y: tree(GENE_TREE, geneHeight) },
                        },
                    ],
                },
            ],
        };
    }

    it("names the block and the slot of a tree column that the tree table does not hold, and no page lands", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: treeDoc("merge_height"), snapshot: treeSnapshot });
        const tool = createPreviewReportTool({ gateway, makeResolver: () => createFixtureResolver(), resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        // The structural tier reads the rows of the snapshot, thus the finish names the gap before the value tier runs.
        expect(result.outcome).toBe("gaps");
        if (result.outcome === "gaps") {
            expect(result.gaps.map((gap) => (gap.kind === "unresolved-reference" ? [gap.blockId, gap.slot, gap.failure.detail] : [gap.kind]))).toEqual([
                ["hm", "tree:y", "the chart names column merge_height, which the bound table does not hold"],
            ]);
        }
        expect(existsSync(join(root, "report-sessions"))).toBe(false);
    });

    it("resolves each tree through the fixture resolver, and the page draws the matrix in the leaf order with a dendrogram on each axis", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: treeDoc(), snapshot: treeSnapshot });
        const tool = createPreviewReportTool({ gateway, makeResolver: () => createFixtureResolver(), resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        if (result.outcome === "rendered") {
            const content = await readFile(result.pagePath, "utf8");
            // The sample tree puts treated1 first, and the gene tree puts Treh first.
            expect(content).toContain('"data":["treated1","untreated2","untreated1"]');
            expect(content).toContain('"data":["Treh","Kal1"]');
            expect(content.match(/"type":"lines"/g)?.length).toBe(2);
            // The appendix lists the binding and each tree.
            for (const path of [CHART_PATH, SAMPLE_TREE, GENE_TREE]) expect(content).toContain(path);
        }
    });
});

describe("the session refusal", () => {
    it("refuses a call whose scope carries no thread id", async () => {
        const root = await makeRoot();
        const tool = createPreviewReportTool({
            gateway: makeFakeGateway(),
            makeResolver: () => createFixtureResolver(),
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
            makeResolver: () => createFixtureResolver(),
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
        const tool = createPreviewReportTool({ gateway, makeResolver: () => createFixtureResolver(), resolveWorkspaceRoot: () => root });

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

describe("the result detail", () => {
    /** Run the tool's result hook, asserting that the tool declares one. */
    function detailOf(tool: ReturnType<typeof createPreviewReportTool>, result: PreviewReportResult): string {
        expect(tool.describeResult).toBeDefined();
        return tool.describeResult!({}, result);
    }

    it("names the page path of a render", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        expect(detailOf(tool, result)).toBe(`page ${join(root, "report-sessions", "t1", "index.html")}`);
    });

    it("names the outcome kind of a degraded arm", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: { title: "", sections: [] }, snapshot: { artifacts: {} } });
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("gaps");
        expect(detailOf(tool, result)).toBe("gaps");
    });

    // The page landed and the marker did not, thus the line must not read as a clean pass.
    it("names the stamp failure, and never the page that it left on disk", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
        });

        expect(detailOf(tool, { outcome: "stamp-failed", pagePath: join(root, "page.html"), detail: "the store is down" })).toBe("stamp-failed");
        expect(detailOf(tool, { outcome: "refused", refusal: { reason: "absent-state", detail: "no session" } })).toBe("refused");
    });
});

describe("the hosted view", () => {
    /** A publisher whose one grant carries the content-server base, thus the tool spells the whole URL. */
    const grantingPublisher: SessionPagePublisher = {
        mintSessionPageAccess: () => okAsync({ baseUrl: "https://content.test/", token: "tok/en", expiresAt: "2026-08-17T00:00:00Z" }),
    };

    it("attaches the URL of the session page beside the path when the publisher grants", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        let scope: { analysisId: string; auth: AuthContext } | undefined;
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
            makeSessionPages: (s) => {
                scope = s;
                return grantingPublisher;
            },
        });

        const ctx = ctxForThread("t1");
        const result = (await tool.execute({}, ctx))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        // The factory binds the analysis and the auth of the call, thus a realization mints under the
        // credential of the caller.
        expect(scope).toEqual({ analysisId: DEFAULT_ANALYSIS_ID, auth: ctx.session.auth });
        if (result.outcome === "rendered") {
            // The page path stays the local contract, and the URL rides beside it. The URL spells the
            // res space of the contract, thus the analysis id and the thread id both name the boundary.
            expect(result.pagePath).toBe(join(root, "report-sessions", "t1", "index.html"));
            expect(result.access).toEqual({
                granted: true,
                url: `https://content.test/report-sessions/${DEFAULT_ANALYSIS_ID}/t1/index.html?t=tok%2Fen`,
                expiresAt: "2026-08-17T00:00:00Z",
            });
        }
    });

    it("carries a refused mint as data, and the render stays good", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
            makeSessionPages: () => ({ mintSessionPageAccess: () => errAsync({ status: 403, error: { message: "no grant" } }) }),
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        if (result.outcome === "rendered") {
            expect(existsSync(result.pagePath)).toBe(true);
            expect(result.access).toEqual({ granted: false, detail: "session-page-access mint failed: status=403 no grant" });
        }
    });

    it("carries the unavailable default as data", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
            makeSessionPages: () => new UnavailableSessionPagePublisher(),
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        if (result.outcome === "rendered") {
            expect(result.access).toEqual({
                granted: false,
                detail: "session-page-access mint failed: the hosted view of a session page is unavailable in this environment",
            });
        }
    });

    it("carries a rejected realization as data, and the render stays good", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
            makeSessionPages: () => ({ mintSessionPageAccess: () => new ResultAsync(Promise.reject(new Error("the grant surface is down"))) }),
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        if (result.outcome === "rendered") {
            expect(existsSync(result.pagePath)).toBe(true);
            expect(result.access).toEqual({ granted: false, detail: "session-page-access mint failed" });
        }
    });

    it("carries a thrown construction as data, and the render stays good", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
            makeSessionPages: () => {
                throw new Error("the publisher did not build");
            },
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        if (result.outcome === "rendered") {
            expect(existsSync(result.pagePath)).toBe(true);
            expect(result.access).toEqual({ granted: false, detail: "session-page-access mint failed" });
        }
    });

    it("carries no access field when the composition binds no publisher", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        // An unbound publisher changes nothing: the arm carries the path alone, the same as before the seam.
        expect("access" in result).toBe(false);
    });
});

describe("the report observation", () => {
    it("gives one preview event with the page and the hash of the draft that it shows", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        const draft = metricDoc();
        gateway.seed("t1", { document: draft, snapshot: metricSnapshot });
        const events: SessionProvenanceEvent[] = [];
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
            provenance: { emitSessionEvent: (event) => events.push(event) },
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        // The hash of the event equals the hash that the stamp wrote, thus the event and the session state
        // name one draft.
        expect(events).toEqual([
            {
                type: "preview",
                analysisId: DEFAULT_ANALYSIS_ID,
                threadId: "t1",
                pagePath: join(root, "report-sessions", "t1", "index.html"),
                documentHash: computeDraftHash(draft),
            },
        ]);
        expect(gateway.renderedHash("t1")).toBe(computeDraftHash(draft));
    });

    it("emits nothing when the draft gives a gap list, and no page lands", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: { title: "", sections: [] }, snapshot: { artifacts: {} } });
        const events: SessionProvenanceEvent[] = [];
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
            provenance: { emitSessionEvent: (event) => events.push(event) },
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("gaps");
        expect(events).toEqual([]);
    });

    it("logs a throw of the seam, and the page stays on disk", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const logger = createCapturingLogger();
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
            provenance: {
                emitSessionEvent: () => {
                    throw new Error("the recorder is down");
                },
            },
            logger,
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        // The page landed before the emit, thus a defect of the host costs the event alone.
        expect(result.outcome).toBe("rendered");
        if (result.outcome === "rendered") {
            expect(existsSync(result.pagePath)).toBe(true);
        }
        const record = logger.records.find((held) => held.msg.includes("the session emit of the provenance seam threw"));
        expect(record?.level).toBe("error");
        expect(record?.fields).toMatchObject({ analysisId: DEFAULT_ANALYSIS_ID, threadId: "t1", event: "preview", err: "the recorder is down" });
    });

    it("renders the same way when the composition binds no seam", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        const draft = metricDoc();
        gateway.seed("t1", { document: draft, snapshot: metricSnapshot });
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        expect(gateway.renderedHash("t1")).toBe(computeDraftHash(draft));
    });
});

describe("the provenance export", () => {
    const DOCUMENT = '{"entity":{"e1":{"prov:type":"file"}}}';
    const ATTESTATION = '{"signature":"AAAA"}';

    /** The assets directory of the seeded thread. */
    function assetsDirOf(root: string): string {
        return join(root, "report-sessions", "t1", "assets");
    }

    /** Each staged provenance asset, in name order. */
    async function stagedProvenance(root: string): Promise<string[]> {
        return (await readdir(assetsDirOf(root))).filter((name) => name.startsWith("prov-")).sort();
    }

    /** A tool over a seeded metric draft, with the given provenance source. */
    function toolOver(root: string, readExport?: ProvenanceSeam["readExport"]): ReturnType<typeof createPreviewReportTool> {
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        return createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
            ...(readExport ? { provenance: { readExport } } : {}),
        });
    }

    it("stages the document and the attestation beside the page, and the page loads both", async () => {
        const root = await makeRoot();
        const asked: string[] = [];
        const tool = toolOver(root, (analysisId) => {
            asked.push(analysisId);
            return { document: DOCUMENT, attestation: ATTESTATION };
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        // The source binds one analysis, thus the tool asks for the analysis of the call.
        expect(asked).toEqual([DEFAULT_ANALYSIS_ID]);
        const staged = await stagedProvenance(root);
        expect(staged.length).toBe(2);
        const page = await readFile(join(root, "report-sessions", "t1", "index.html"), "utf8");
        for (const name of staged) {
            expect(await readFile(join(assetsDirOf(root), name), "utf8")).toContain(name.endsWith(".sig.data.js") ? "signature" : "prov:type");
            expect(page).toContain(`assets/${name}`);
        }
        assertNoLegacyDirs(root);
    });

    it("takes the document of an async source", async () => {
        const root = await makeRoot();
        const tool = toolOver(root, () => Promise.resolve({ document: DOCUMENT }));

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        // A source can read a file or ask a service, thus the tool awaits the result of the call.
        expect(await stagedProvenance(root)).toHaveLength(1);
    });

    it("stages no provenance asset when the source gives absence", async () => {
        const root = await makeRoot();
        const tool = toolOver(root, () => undefined);

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        // Absence is a normal result: the page lands, and it carries no provenance.
        expect(result.outcome).toBe("rendered");
        expect(await stagedProvenance(root)).toEqual([]);
        expect(await readFile(join(root, "report-sessions", "t1", "index.html"), "utf8")).not.toContain("prov-");
    });

    it("stages no provenance asset when the composition binds no source", async () => {
        const root = await makeRoot();
        const tool = toolOver(root);

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        expect(await stagedProvenance(root)).toEqual([]);
    });

    // Each member of the seam is optional alone, thus a composition that records the acts alone gets the
    // events and a page with no document.
    it("emits the act and stages no provenance asset when the seam carries the session emit alone", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const events: SessionProvenanceEvent[] = [];
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
            provenance: { emitSessionEvent: (event) => events.push(event) },
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("rendered");
        expect(events.map((event) => event.type)).toEqual(["preview"]);
        expect(await stagedProvenance(root)).toEqual([]);
    });

    it("stages the new document under a new name, and the sweep removes the old one", async () => {
        const root = await makeRoot();
        let document = DOCUMENT;
        const tool = toolOver(root, () => ({ document }));

        const first = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();
        expect(first.outcome).toBe("rendered");
        const afterFirst = await stagedProvenance(root);
        expect(afterFirst).toHaveLength(1);

        document = '{"entity":{"e2":{"prov:type":"file"}}}';
        const second = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(second.outcome).toBe("rendered");
        // The name carries the hash of the bytes, thus the changed document lands beside no stale copy of
        // itself and the stage stays the closure of the page.
        const afterSecond = await stagedProvenance(root);
        expect(afterSecond).toHaveLength(1);
        expect(afterSecond[0]).not.toBe(afterFirst[0]);
        expect(await readFile(join(root, "report-sessions", "t1", "index.html"), "utf8")).toContain(`assets/${afterSecond[0]}`);
    });

    it("logs a throw of the source, and the page lands with no provenance asset", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { document: metricDoc(), snapshot: metricSnapshot });
        const logger = createCapturingLogger();
        const tool = createPreviewReportTool({
            gateway,
            makeResolver: () => createFixtureResolver(),
            resolveWorkspaceRoot: () => root,
            provenance: {
                readExport: () => {
                    throw new Error("the document store is down");
                },
            },
            logger,
        });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        // The provenance is an addition to the report, thus a defect of the host costs the addition alone.
        expect(result.outcome).toBe("rendered");
        expect(await stagedProvenance(root)).toEqual([]);
        const record = logger.records.find((held) => held.msg.includes("the document read of the provenance seam threw"));
        expect(record?.level).toBe("error");
        expect(record?.fields).toMatchObject({ analysisId: DEFAULT_ANALYSIS_ID, err: "the document store is down" });
    });
});
