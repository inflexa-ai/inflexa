/**
 * The tests of the pinned-artifact listing tool.
 *
 * Each test drives the tool through `execute` with a temp directory as the workspace root and an
 * in-memory gateway. The tests cover the order of the listing, the cap of the listing, the columns of a
 * CSV and of a TSV, the extension that carries no header, the cut header line, the quoted header, the
 * absent file, the file type that holds no cell, the pinned citations, and the session refusal.
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

describe("the listing cap", () => {
    /** Seed a snapshot of `count` staged inputs. The names pad, thus the code-unit order is the numeric order. */
    function stagedInputs(count: number): ReportSnapshot {
        const artifacts: ReportSnapshot["artifacts"] = {};
        for (let index = 0; index < count; index += 1) {
            artifacts[`data/inputs/f${String(index).padStart(3, "0")}/raw.csv`] = { hash: `sha256:${index}`, fileType: "output" };
        }
        return { artifacts };
    }

    it("lists the first 200 paths of a large pinned set, and it marks the listing as truncated", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", stagedInputs(250));
        const tool = createListPinnedArtifactsTool({ gateway, resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("listed");
        if (result.outcome === "listed") {
            expect(result.artifacts).toHaveLength(200);
            expect(result.total).toBe(250);
            expect(result.truncated).toBe(true);
            // The cap cuts the tail of the order, thus the listing is the prefix of the whole listing.
            expect(result.artifacts[0].path).toBe("data/inputs/f000/raw.csv");
            expect(result.artifacts[199].path).toBe("data/inputs/f199/raw.csv");
        }
    });

    it("marks a set under the cap as complete, and it gives the total", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", stagedInputs(3));
        const tool = createListPinnedArtifactsTool({ gateway, resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("listed");
        if (result.outcome === "listed") {
            expect(result.artifacts).toHaveLength(3);
            expect(result.total).toBe(3);
            expect(result.truncated).toBe(false);
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

    it("reads the header of a path whose extension is uppercase", async () => {
        const root = await makeRoot();
        await writeUnder(root, "runs/r1/step-a/output/DE.CSV", "gene,padj\nTP53,0.01\n");
        const gateway = makeFakeGateway();
        gateway.seed("t1", { artifacts: { "runs/r1/step-a/output/DE.CSV": { hash: "sha256:aaa", fileType: "output" } } });
        const tool = createListPinnedArtifactsTool({ gateway, resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("listed");
        if (result.outcome === "listed") {
            expect(result.artifacts[0].columns).toEqual(["gene", "padj"]);
        }
    });

    it("reads no header for an extension that carries none, even under an output file type", async () => {
        const root = await makeRoot();
        // A minified JSON holds a comma at each field, thus a split of it gives many names that address nothing.
        await writeUnder(root, "runs/r1/step-a/output/results.json", '{"gene":"TP53","padj":0.01,"log2fc":2.5}\n');
        const gateway = makeFakeGateway();
        gateway.seed("t1", { artifacts: { "runs/r1/step-a/output/results.json": { hash: "sha256:aaa", fileType: "output" } } });
        const tool = createListPinnedArtifactsTool({ gateway, resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("listed");
        if (result.outcome === "listed") {
            expect(result.artifacts[0].fileType).toBe("output");
            expect(result.artifacts[0].columns).toBeUndefined();
        }
    });

    it("gives no columns for a header line that holds a double quote", async () => {
        const root = await makeRoot();
        // The quoted field holds the delimiter, thus a naive split gives two wrong names for one column.
        await writeUnder(root, "runs/r1/step-a/output/quoted.csv", '"gene, symbol",padj\nTP53,0.01\n');
        const gateway = makeFakeGateway();
        gateway.seed("t1", { artifacts: { "runs/r1/step-a/output/quoted.csv": { hash: "sha256:aaa", fileType: "output" } } });
        const tool = createListPinnedArtifactsTool({ gateway, resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("listed");
        if (result.outcome === "listed") {
            expect(result.artifacts[0].columns).toBeUndefined();
        }
    });

    it("drops the last name of a header line that the read cut", async () => {
        const root = await makeRoot();
        // The header overflows the 16 KiB window, thus the bytes stop inside one name.
        const names = Array.from({ length: 3000 }, (_, index) => `col${String(index).padStart(4, "0")}`);
        await writeUnder(root, "runs/r1/step-a/output/wide.csv", `gene,${names.join(",")}\nTP53\n`);
        const gateway = makeFakeGateway();
        gateway.seed("t1", { artifacts: { "runs/r1/step-a/output/wide.csv": { hash: "sha256:aaa", fileType: "output" } } });
        const tool = createListPinnedArtifactsTool({ gateway, resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("listed");
        if (result.outcome === "listed") {
            const columns = result.artifacts[0].columns ?? [];
            expect(columns[0]).toBe("gene");
            // Each name that lands is whole, thus a locator that names one addresses a real column.
            expect(columns.every((name) => name === "gene" || /^col\d{4}$/.test(name))).toBe(true);
            expect(columns.length).toBeLessThan(names.length);
        }
    });

    it("gives no columns when the cut leaves no whole name", async () => {
        const root = await makeRoot();
        // One name overflows the window and no delimiter lands inside it, thus nothing whole comes out.
        await writeUnder(root, "runs/r1/step-a/output/one.csv", `${"g".repeat(20000)}\n`);
        const gateway = makeFakeGateway();
        gateway.seed("t1", { artifacts: { "runs/r1/step-a/output/one.csv": { hash: "sha256:aaa", fileType: "output" } } });
        const tool = createListPinnedArtifactsTool({ gateway, resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("listed");
        if (result.outcome === "listed") {
            expect(result.artifacts[0].columns).toBeUndefined();
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

describe("the pinned citations", () => {
    it("gives the stored citation keys in the order that the pin wrote", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", {
            artifacts: { "runs/r1/step-a/output/de.csv": { hash: "sha256:aaa", fileType: "output" } },
            citations: ["pmid:12345", "pmid:42", "pmid:999"],
        });
        const tool = createListPinnedArtifactsTool({ gateway, resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("listed");
        if (result.outcome === "listed") {
            // The agent binds a citation block to one of these ids, thus the listing is the route to an
            // id and a refusal never has to teach one.
            expect(result.citations).toEqual(["pmid:12345", "pmid:42", "pmid:999"]);
        }
    });

    it("gives an empty list for a snapshot that pinned no citation", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", { artifacts: { "runs/r1/step-a/output/de.csv": { hash: "sha256:aaa", fileType: "output" } } });
        const tool = createListPinnedArtifactsTool({ gateway, resolveWorkspaceRoot: () => root });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("listed");
        if (result.outcome === "listed") {
            expect(result.citations).toEqual([]);
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
