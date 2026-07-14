import { describe, expect, it } from "bun:test";

import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SandboxClient } from "../../sandbox/client.js";
import type { CreateSandboxMeta, ExecEmit, ExecResult, SandboxRef, SubmitExecBody } from "../../sandbox/types.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createListAvailableRefsTool } from "./list-available-refs.js";

const HASH = "a".repeat(64);
const sandbox: SandboxRef = {
    sandboxId: "sb-refs",
    host: "127.0.0.1",
    port: 8765,
    backend: "docker",
    callbackSecret: "secret",
};

interface FakeClient extends SandboxClient {
    readonly submits: SubmitExecBody[];
}

interface ExecutingClient extends FakeClient {
    readonly outputs: string[];
}

function makeClient(payload: unknown): FakeClient {
    const submits: SubmitExecBody[] = [];
    return {
        submits,
        async createSandbox(_meta: CreateSandboxMeta) {
            return sandbox;
        },
        async submitExec(_sandbox: SandboxRef, body: SubmitExecBody) {
            submits.push(body);
        },
        async awaitExec(_sandbox: SandboxRef, execId: string, _emit: ExecEmit, _deadline: number): Promise<ExecResult> {
            return { execId, exitCode: 0, stdout: JSON.stringify(payload), stderr: "", durationMs: 1, timedOut: false };
        },
        async isAlive() {
            return { alive: true, oomKilled: false };
        },
        async teardown() {},
        async teardownById() {},
        async listManagedSandboxes() {
            return [];
        },
    };
}

function makeExecutingClient(): ExecutingClient {
    const submits: SubmitExecBody[] = [];
    const outputs: string[] = [];
    return {
        submits,
        outputs,
        async createSandbox(_meta: CreateSandboxMeta) {
            return sandbox;
        },
        async submitExec(_sandbox: SandboxRef, body: SubmitExecBody) {
            submits.push(body);
        },
        async awaitExec(_sandbox: SandboxRef, execId: string, _emit: ExecEmit, _deadline: number): Promise<ExecResult> {
            const body = submits.at(-1)!;
            const child = Bun.spawn(body.command, { stdout: "pipe", stderr: "pipe" });
            const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
            outputs.push(stdout);
            return { execId, exitCode, stdout, stderr, durationMs: 1, timedOut: false };
        },
        async isAlive() {
            return { alive: true, oomKilled: false };
        },
        async teardown() {},
        async teardownById() {},
        async listManagedSandboxes() {
            return [];
        },
    };
}

function createTool(client: FakeClient, nextFunctionId: () => string = () => "fn-1") {
    return createListAvailableRefsTool({
        sandboxClient: client,
        sandbox,
        workflowId: "wf-1",
        stepId: "step-1",
        nextFunctionId,
        deadlineMs: () => 123_456,
    });
}

function createFilesystemTool(client: FakeClient, scanRoot: string) {
    return createListAvailableRefsTool({
        sandboxClient: client,
        sandbox,
        workflowId: "wf-fs",
        stepId: "step-fs",
        nextFunctionId: (() => {
            let id = 0;
            return () => `fn-${++id}`;
        })(),
        deadlineMs: () => Date.now() + 60_000,
        scanRoot,
    });
}

describe("list_available_refs", () => {
    it("is a dependency-bearing workflow tool and discovers manifest-free user files", async () => {
        const client = makeClient({
            state: "populated",
            entries: [{ path: "/mnt/refs/user/cohort/reference.h5ad", kind: "file", bytes: 42 }],
            scannedEntries: 3,
            truncated: false,
            receipts: [],
            legacyEntries: [],
        });
        const tool = createTool(client);
        const result = (await tool.execute({}, makeToolContext().ctx))._unsafeUnwrap();

        expect(tool.executionMode).toBe("workflow");
        expect(result).toMatchObject({ available: true, state: "populated", truncated: false });
        expect(result.entries[0]).toEqual({ path: "/mnt/refs/user/cohort/reference.h5ad", kind: "file", bytes: 42 });
        expect(client.submits[0]!.execId).toBe("wf-1:step-1:fn-1");
        expect(client.submits[0]!.command.slice(0, 2)).toEqual(["python3", "-c"]);
        expect(client.submits[0]!.command[3]).toBe("/mnt/refs");
        expect(client.submits[0]!.command[4]).toBe(".");
    });

    it("merges valid receipt and legacy enrichment while retaining user files", async () => {
        const managedPath = "/mnt/refs/managed/alpha/2026.07/reference.parquet";
        const catalogPath = "/mnt/refs/managed/ncbi-gene-human/current/Homo_sapiens.gene_info.gz";
        const legacyPath = "/mnt/refs/legacy/pathways.gmt";
        const client = makeClient({
            state: "populated",
            entries: [
                { path: managedPath, kind: "file", bytes: 12 },
                { path: catalogPath, kind: "file", bytes: 15 },
                { path: legacyPath, kind: "file", bytes: 13 },
                { path: "/mnt/refs/user/custom.csv", kind: "file", bytes: 14 },
            ],
            scannedEntries: 5,
            truncated: false,
            receipts: [
                {
                    version: 1,
                    datasetId: "alpha",
                    datasetVersion: "2026.07",
                    activatedAt: "2026-07-14T10:30:00.000Z",
                    artifacts: [{ path: "reference.parquet", bytes: 999, sha256: HASH, integrity: "pinned" }],
                },
                {
                    version: 1,
                    datasetId: "ncbi-gene-human",
                    datasetVersion: "current",
                    activatedAt: "2026-07-14T10:30:00.000Z",
                    artifacts: [{ path: "Homo_sapiens.gene_info.gz", bytes: 1_024, sha256: HASH, integrity: "unpinned" }],
                },
            ],
            legacyEntries: [{ local_path: "legacy/pathways.gmt", category: "pathways", dataset: "legacy-pathways", rows: 200 }],
        });

        const result = (await createTool(client).execute({}, makeToolContext().ctx))._unsafeUnwrap();

        expect(result.entries).toHaveLength(4);
        // Receipt for a dataset the catalog does not know: identity only, no provenance labels.
        expect(result.entries.find((entry) => entry.path === managedPath)).toMatchObject({
            bytes: 12,
            metadata: { datasetId: "alpha", version: "2026.07" },
        });
        // Receipt for a catalog dataset: provenance is joined in from the catalog entry.
        expect(result.entries.find((entry) => entry.path === catalogPath)).toMatchObject({
            bytes: 15,
            metadata: {
                datasetId: "ncbi-gene-human",
                version: "current",
                title: "NCBI human gene identifiers",
                sourceUrl: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Mammalia/",
                license: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
            },
        });
        expect(result.entries.find((entry) => entry.path === legacyPath)).toMatchObject({
            bytes: 13,
            metadata: { datasetId: "legacy-pathways", category: "pathways", rows: 200 },
        });
        expect(result.entries.find((entry) => entry.path.includes("/user/"))?.metadata).toBeUndefined();
    });

    it("ignores a receipt artifact that records no observed integrity", async () => {
        const managedPath = "/mnt/refs/managed/alpha/2026.07/reference.parquet";
        const client = makeClient({
            state: "populated",
            entries: [{ path: managedPath, kind: "file", bytes: 12 }],
            scannedEntries: 1,
            truncated: false,
            receipts: [
                {
                    version: 1,
                    datasetId: "alpha",
                    datasetVersion: "2026.07",
                    activatedAt: "2026-07-14T10:30:00.000Z",
                    artifacts: [{ path: "reference.parquet", bytes: 999, sha256: HASH }],
                },
            ],
        });

        const result = (await createTool(client).execute({}, makeToolContext().ctx))._unsafeUnwrap();
        expect(result.entries).toEqual([{ path: managedPath, kind: "file", bytes: 12 }]);
    });

    it("ignores invalid and stale metadata without hiding observed files", async () => {
        const client = makeClient({
            state: "populated",
            entries: [{ path: "/mnt/refs/user/observed.csv", kind: "file", bytes: 7 }],
            scannedEntries: 1,
            truncated: false,
            receipts: [{ version: 99, datasetId: "bad" }],
            legacyEntries: [{ local_path: "missing.csv", category: "stale" }],
        });

        const result = (await createTool(client).execute({}, makeToolContext().ctx))._unsafeUnwrap();
        expect(result.entries).toEqual([{ path: "/mnt/refs/user/observed.csv", kind: "file", bytes: 7 }]);
    });

    it.each([
        ["unavailable", false, "not mounted"],
        ["empty", true, "contains no reference files"],
    ] as const)("returns expected %s state as data", async (state, available, content) => {
        const client = makeClient({ state, entries: [], scannedEntries: 0, truncated: false });
        const result = (await createTool(client).execute({}, makeToolContext().ctx))._unsafeUnwrap();
        expect(result).toMatchObject({ state, available, entries: [] });
        expect(result.content).toContain(content);
    });

    it.each(["../etc", "/etc/passwd", "/mnt/refs/../etc", "user//cohort", ".inflexa/receipts"])(
        "rejects out-of-scope path %s without executing",
        async (path) => {
            const client = makeClient({});
            const result = (await createTool(client).execute({ path }, makeToolContext().ctx))._unsafeUnwrap();
            expect(result).toMatchObject({ state: "out_of_scope", available: false });
            expect(client.submits).toHaveLength(0);
        },
    );

    it("bounds an oversized zero-entry path rejection without executing", async () => {
        const client = makeClient({});
        const result = (await createTool(client).execute({ path: "a".repeat(70_000) }, makeToolContext().ctx))._unsafeUnwrap();
        expect(result).toMatchObject({ state: "out_of_scope", available: false, path: "/mnt/refs", entries: [] });
        expect(result.content).toContain("4096-byte");
        expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(64_000);
        expect(client.submits).toHaveLength(0);
    });

    it("reports symlinks without following them", async () => {
        const client = makeClient({
            state: "populated",
            entries: [{ path: "/mnt/refs/user/external", kind: "symlink", bytes: 0 }],
            scannedEntries: 1,
            truncated: false,
        });
        const result = (await createTool(client).execute({ path: "user" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(result.entries[0]).toMatchObject({ kind: "symlink", path: "/mnt/refs/user/external" });
        expect(client.submits[0]!.command[4]).toBe("user");
    });

    it("surfaces bounded traversal truncation with a drill-down hint", async () => {
        const client = makeClient({
            state: "populated",
            entries: [{ path: "/mnt/refs/shards/0001.parquet", kind: "file", bytes: 5 }],
            scannedEntries: 2000,
            truncated: true,
        });
        const result = (await createTool(client).execute({}, makeToolContext().ctx))._unsafeUnwrap();
        expect(result.truncated).toBe(true);
        expect(result.content).toContain("narrower path");
    });

    it("derives the same exec id across replay", async () => {
        const payload = { state: "empty", entries: [], scannedEntries: 0, truncated: false };
        const first = makeClient(payload);
        const replay = makeClient(payload);
        await createTool(first, () => "stable").execute({}, makeToolContext().ctx);
        await createTool(replay, () => "stable").execute({}, makeToolContext().ctx);
        expect(first.submits[0]!.execId).toBe(replay.submits[0]!.execId);
    });

    it("runs the real scanner against manifest-free trees and supports directory drill-down", async () => {
        const root = await mkdtemp(join(tmpdir(), "refs-scan-"));
        const outside = await mkdtemp(join(tmpdir(), "refs-outside-"));
        await mkdir(join(root, "user", "cohort"), { recursive: true });
        await writeFile(join(root, "user", "cohort", "reference.h5ad"), "reference");
        await writeFile(join(outside, "registry.json"), JSON.stringify({ files: { by_category: { fake: [{ local_path: "user/cohort/reference.h5ad" }] } } }));
        await symlink(join(outside, "registry.json"), join(root, "registry.json"));
        await symlink(outside, join(root, ".inflexa"));
        await symlink(outside, join(root, "user", "external"));

        const client = makeExecutingClient();
        const tool = createFilesystemTool(client, root);
        const rootResult = (await tool.execute({}, makeToolContext().ctx))._unsafeUnwrap();
        expect(rootResult.entries).toEqual([expect.objectContaining({ path: "/mnt/refs/user", kind: "directory", fileCount: 1, bytes: 9 })]);
        expect(rootResult.entries[0]?.metadata).toBeUndefined();

        const userResult = (await tool.execute({ path: "/mnt/refs/user" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(userResult.entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ path: "/mnt/refs/user/cohort", kind: "directory", fileCount: 1 }),
                { path: "/mnt/refs/user/external", kind: "symlink", bytes: 0 },
            ]),
        );

        const cohortResult = (await tool.execute({ path: "/mnt/refs/user/cohort" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(cohortResult.entries).toEqual([{ path: "/mnt/refs/user/cohort/reference.h5ad", kind: "file", bytes: 9 }]);
        expect(client.outputs.every((output) => Buffer.byteLength(output) <= 64_001)).toBe(true);
    });

    // A single unparseable receipt used to abort the scan loop, silently dropping every receipt
    // that sorted after it — so one corrupt file stripped the labels off datasets that were fine.
    it("keeps enriching from the receipts that parse when one of them is corrupt", async () => {
        const root = await mkdtemp(join(tmpdir(), "refs-bad-receipt-"));
        const version = join(root, "managed", "wikipathways-human", "2026.07.10");
        await mkdir(version, { recursive: true });
        await mkdir(join(root, ".inflexa", "receipts"), { recursive: true });
        await writeFile(join(version, "wikipathways_Homo_sapiens.gmt"), "pathway\tdescription\tGENE");

        // "aaa" sorts before "wikipathways", so a loop that dies on the bad file never reaches the good one.
        await writeFile(join(root, ".inflexa", "receipts", "aaa-corrupt.json"), "{ not json");
        await writeFile(
            join(root, ".inflexa", "receipts", "wikipathways-human.json"),
            JSON.stringify({
                version: 1,
                datasetId: "wikipathways-human",
                datasetVersion: "2026.07.10",
                activatedAt: "2026-07-14T10:30:00.000Z",
                artifacts: [{ path: "wikipathways_Homo_sapiens.gmt", bytes: 31, sha256: HASH, integrity: "pinned" }],
            }),
        );

        const tool = createFilesystemTool(makeExecutingClient(), root);
        const result = (await tool.execute({ path: "/mnt/refs/managed/wikipathways-human/2026.07.10" }, makeToolContext().ctx))._unsafeUnwrap();

        expect(result.state).toBe("populated");
        expect(result.entries[0]).toMatchObject({
            path: "/mnt/refs/managed/wikipathways-human/2026.07.10/wikipathways_Homo_sapiens.gmt",
            kind: "file",
            metadata: { datasetId: "wikipathways-human", title: "WikiPathways human pathways" },
        });
    });

    it("bounds the real scanner and final tool envelope for large subtrees and metadata", async () => {
        const root = await mkdtemp(join(tmpdir(), "refs-large-"));
        await mkdir(join(root, "shards"), { recursive: true });
        for (let start = 0; start < 2_100; start += 200) {
            await Promise.all(
                Array.from({ length: Math.min(200, 2_100 - start) }, (_, offset) => {
                    const index = start + offset;
                    return writeFile(join(root, "shards", `${String(index).padStart(4, "0")}.parquet`), "x");
                }),
            );
        }
        const huge = "x".repeat(500);
        await writeFile(
            join(root, "registry.json"),
            JSON.stringify({
                files: {
                    by_category: {
                        huge: Array.from({ length: 200 }, (_, index) => ({ local_path: `shards/${String(index).padStart(4, "0")}.parquet`, dataset: huge })),
                    },
                },
            }),
        );

        const client = makeExecutingClient();
        const tool = createFilesystemTool(client, root);
        const summary = (await tool.execute({}, makeToolContext().ctx))._unsafeUnwrap();
        expect(summary.scannedEntries).toBe(2_000);
        expect(summary.entries).toEqual([expect.objectContaining({ path: "/mnt/refs/shards", kind: "directory", truncated: true, fileCount: 1_999 })]);

        const result = (await tool.execute({ path: "shards" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(result.truncated).toBe(true);
        expect(result.entries.length).toBeLessThanOrEqual(200);
        expect(result.content).toContain("narrower path");
        expect(client.outputs.every((output) => Buffer.byteLength(output, "utf8") <= 64_001)).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(64_000);
    });

    it("rejects malformed and oversized scanner stdout", async () => {
        const malformed = makeClient({ state: "populated", entries: "not-an-array", scannedEntries: 1, truncated: false });
        await expect(createTool(malformed).execute({}, makeToolContext().ctx)).rejects.toThrow();

        const oversized = makeClient({ state: "populated", entries: [], scannedEntries: 1, truncated: false, padding: "x".repeat(70_000) });
        await expect(createTool(oversized).execute({}, makeToolContext().ctx)).rejects.toThrow(/exceeded its output bound/);
    });
});
