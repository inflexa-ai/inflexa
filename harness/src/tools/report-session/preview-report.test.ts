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
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Scope } from "../../auth/types.js";
import type { DraftDocument } from "../../report-model/draft.js";
import { computeDraftHash } from "../../report-model/draft-hash.js";
import { createFixtureResolver } from "../../report-model/fixture-resolver.js";
import type { ReportSnapshot } from "../../report-model/reference-resolver.js";
import { DEPS_DIR, derivationScriptName, PAGE_ASSETS, tableSidecarName } from "../../report-render/assets.js";
import type { DerivationRecord } from "../../state/report-session-state.js";
import type { ReportSessionState, ReportSessionStateGateway, SessionStateLoad, SessionStatePersist, StampResult } from "../report-authoring/authoring-tools.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import type { ToolContext } from "../define-tool.js";
import { createPreviewReportTool, type PreviewReportResult } from "./preview-report.js";

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
