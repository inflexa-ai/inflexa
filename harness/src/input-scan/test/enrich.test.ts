import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";

import type { SandboxClient } from "../../sandbox/client.js";
import { makeFakeSandboxClient } from "../../agents/sandbox/__fixtures__/deps.js";
import type { ExecRequest, ExecResult } from "../../sandbox/types.js";
import type { ListResult, ReadBytesResult, ReadFileResult, StatResult, WorkspaceFilesystem } from "../../workspace/filesystem.js";
import { enrichShapes, readHeaders, type EnrichShapesArgs } from "../enrich.js";
import { observeShapes } from "../shapes.js";
import type { ScannedFile } from "../types.js";
import type { AgentSession } from "../../auth/types.js";
import { presentAt, presentFind } from "../../lib/present.js";

const SESSION: AgentSession = {
    identity: { user: "tester" },
    scope: { kind: "analysis", analysisId: "analysis-1" },
    provenance: { agentId: "enrich", callPath: ["enrich"] },
    auth: {},
};

function file(path: string, format: string): ScannedFile {
    const base = path.slice(path.lastIndexOf("/") + 1);
    const dot = base.indexOf(".");
    return { path, size: 4096, extensions: dot <= 0 ? [] : base.slice(dot + 1).split("."), format };
}

/** Four shapes over a few thousand files — cost has to stay on the shape count. */
function motivatingTree(): ScannedFile[] {
    const pad = (n: number) => String(n).padStart(4, "0");
    return [
        ...Array.from({ length: 800 }, (_, i) => file(`data/inputs/vcf/PATIENT_${pad(i + 1)}.vcf.gz`, "vcf")),
        ...Array.from({ length: 800 }, (_, i) => file(`data/inputs/tbi/PATIENT_${pad(i + 1)}.vcf.gz.tbi`, "tabix-index")),
        ...Array.from({ length: 1200 }, (_, i) => file(`data/inputs/bam/SAMPLE_${pad(i + 1)}.bam`, "bam")),
        ...Array.from({ length: 3 }, (_, i) => file(`data/inputs/meta/sheet_${i + 1}.csv`, "csv")),
    ];
}

/** A read seam over an in-memory tree; every read is recorded with its byte budget. */
function readSeam(contents: Record<string, Buffer>): { fs: WorkspaceFilesystem; reads: { path: string; length: number }[] } {
    const reads: { path: string; length: number }[] = [];
    const fs: WorkspaceFilesystem = {
        readFile: () => okAsync<ReadFileResult>({ kind: "not_found" }),
        readBytes({ path, length }: { path: string; length: number }) {
            reads.push({ path, length });
            const bytes = contents[path];
            return okAsync<ReadBytesResult>(bytes ? { kind: "ok", bytes: bytes.subarray(0, length) } : { kind: "not_found" });
        },
        stat: () => okAsync<StatResult>({ kind: "not_found" }),
        list: () => okAsync<ListResult>({ kind: "not_found" }),
    };
    return { fs, reads };
}

function recordingSandbox(): { client: SandboxClient; submitted: ExecRequest[] } {
    const submitted: ExecRequest[] = [];
    const client: SandboxClient = {
        ...makeFakeSandboxClient(),
        exec(_ref: unknown, request: ExecRequest): Promise<ExecResult> {
            submitted.push(request);
            const paths = request.command.slice(3);
            const stdout = paths.map((path) => JSON.stringify({ path, fields: { columnCount: 7 } })).join("\n");
            return Promise.resolve({ execId: "wf:7", exitCode: 0, stdout, stderr: "", durationMs: 5, timedOut: false });
        },
    };
    return { client, submitted };
}

/** A sandbox whose decoder exec produced no usable stdout, with the outcome under test. */
function failingSandbox(result: Partial<ExecResult>): SandboxClient {
    return {
        ...makeFakeSandboxClient(),
        exec(): Promise<ExecResult> {
            return Promise.resolve({ execId: "wf:7", exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, ...result });
        },
    };
}

function enrichArgs(overrides: Pick<EnrichShapesArgs, "shapes" | "fs"> & Partial<EnrichShapesArgs>) {
    return {
        session: SESSION,
        mountRoot: "/a1",
        deadlineMs: Date.now() + 60_000,
        emit: async () => {},
        ...overrides,
    };
}

describe("enrichShapes", () => {
    it("reads one member per shape, not one per file, and never touches the sandbox for them", async () => {
        const observed = observeShapes(motivatingTree());
        const { fs, reads } = readSeam({});
        const { client, submitted } = recordingSandbox();

        const shapes = await enrichShapes(
            enrichArgs({ shapes: observed.shapes, fs, sandboxClient: client, sandbox: { sandboxId: "s1", host: "127.0.0.1", port: 8080, backend: "docker" } }),
        );

        expect(reads.map((read) => read.path).sort()).toEqual([
            "data/inputs/bam/SAMPLE_0001.bam",
            "data/inputs/meta/sheet_1.csv",
            "data/inputs/tbi/PATIENT_0001.vcf.gz.tbi",
            "data/inputs/vcf/PATIENT_0001.vcf.gz",
        ]);
        expect(submitted).toEqual([]);
        expect(shapes.map((shape) => shape.header?.path).sort()).toEqual([
            "data/inputs/bam/SAMPLE_0001.bam",
            "data/inputs/meta/sheet_1.csv",
            "data/inputs/tbi/PATIENT_0001.vcf.gz.tbi",
            "data/inputs/vcf/PATIENT_0001.vcf.gz",
        ]);
    });

    it("reads a header in process, with no sandbox wired at all", async () => {
        const observed = observeShapes([file("data/inputs/meta/sheet_1.csv", "csv"), file("data/inputs/meta/sheet_2.csv", "csv")]);
        const { fs } = readSeam({ "data/inputs/meta/sheet_1.csv": Buffer.from("subject,arm,dose\nS1,a,10\n") });

        const shapes = await enrichShapes(enrichArgs({ shapes: observed.shapes, fs }));

        expect(presentAt(shapes, 0).header?.fields).toMatchObject({ delimiter: "comma", columnCount: 3, columns: "subject, arm, dose" });
    });

    it("bounds the read it issues per member", async () => {
        const observed = observeShapes([file("data/inputs/meta/sheet_1.csv", "csv"), file("data/inputs/meta/sheet_2.csv", "csv")]);
        const { fs, reads } = readSeam({});

        await enrichShapes(enrichArgs({ shapes: observed.shapes, fs }));

        expect(presentAt(reads, 0).length).toBe(262_144);
    });

    it("notes an unreadable member instead of dropping its shape", async () => {
        const observed = observeShapes([file("data/inputs/meta/sheet_1.csv", "csv"), file("data/inputs/meta/sheet_2.csv", "csv")]);
        const { fs } = readSeam({});

        const shapes = await enrichShapes(enrichArgs({ shapes: observed.shapes, fs }));

        expect(presentAt(shapes, 0).header?.unavailable).toBe("prefix unreadable (not_found)");
    });

    it("sends only footer-indexed containers to the sandbox decoder", async () => {
        const observed = observeShapes([
            file("data/inputs/tables/counts_1.parquet", "parquet"),
            file("data/inputs/tables/counts_2.parquet", "parquet"),
            file("data/inputs/meta/sheet_1.csv", "csv"),
            file("data/inputs/meta/sheet_2.csv", "csv"),
        ]);
        const { fs } = readSeam({ "data/inputs/meta/sheet_1.csv": Buffer.from("a,b\n1,2\n") });
        const { client, submitted } = recordingSandbox();

        const shapes = await enrichShapes(
            enrichArgs({ shapes: observed.shapes, fs, sandboxClient: client, sandbox: { sandboxId: "s1", host: "127.0.0.1", port: 8080, backend: "docker" } }),
        );

        expect(submitted.map((body) => body.command.slice(3))).toEqual([["/a1/data/inputs/tables/counts_1.parquet"]]);
        expect(presentAt(submitted, 0).command[0]).toBe("python3");
        expect(presentAt(submitted, 0).command[2]).toContain("def parquet_fields(");
        const parquet = presentFind(shapes, (shape) => shape.format === "parquet");
        expect(parquet.header?.fields).toEqual({ columnCount: 7 });
        expect(parquet.header?.path).toBe("data/inputs/tables/counts_1.parquet");
    });

    it("skips the container readout when no sandbox is wired, keeping the shape", async () => {
        const observed = observeShapes([file("data/inputs/tables/counts_1.parquet", "parquet"), file("data/inputs/tables/counts_2.parquet", "parquet")]);
        const { fs } = readSeam({});

        const shapes = await enrichShapes(enrichArgs({ shapes: observed.shapes, fs }));

        expect(shapes).toHaveLength(1);
        expect(presentAt(shapes, 0).header).toBeUndefined();
    });

    it("names the exec's own failure when the decoder produced no line for a container", async () => {
        const observed = observeShapes([file("data/inputs/tables/counts_1.parquet", "parquet"), file("data/inputs/tables/counts_2.parquet", "parquet")]);
        const { fs } = readSeam({});
        const client = failingSandbox({ exitCode: 1, stderr: "python3: not found" });

        const shapes = await enrichShapes(
            enrichArgs({ shapes: observed.shapes, fs, sandboxClient: client, sandbox: { sandboxId: "s1", host: "127.0.0.1", port: 8080, backend: "docker" } }),
        );

        expect(presentAt(shapes, 0).header?.unavailable).toBe("container decoder exited 1: python3: not found");
    });

    it("names a decoder timeout rather than reporting silence", async () => {
        const observed = observeShapes([file("data/inputs/tables/counts_1.parquet", "parquet"), file("data/inputs/tables/counts_2.parquet", "parquet")]);
        const { fs } = readSeam({});
        const client = failingSandbox({ exitCode: null, timedOut: true });

        const shapes = await enrichShapes(
            enrichArgs({ shapes: observed.shapes, fs, sandboxClient: client, sandbox: { sandboxId: "s1", host: "127.0.0.1", port: 8080, backend: "docker" } }),
        );

        expect(presentAt(shapes, 0).header?.unavailable).toBe("container decoder timed out after 120s");
    });

    it("reports silence as silence when the decoder exited cleanly", async () => {
        const observed = observeShapes([file("data/inputs/tables/counts_1.parquet", "parquet"), file("data/inputs/tables/counts_2.parquet", "parquet")]);
        const { fs } = readSeam({});
        const client = failingSandbox({ exitCode: 0 });

        const shapes = await enrichShapes(
            enrichArgs({ shapes: observed.shapes, fs, sandboxClient: client, sandbox: { sandboxId: "s1", host: "127.0.0.1", port: 8080, backend: "docker" } }),
        );

        expect(presentAt(shapes, 0).header?.unavailable).toBe("container decoder reported nothing for this member");
    });

    it("keeps the readouts before a cut last line and gives the cut path the exec outcome", async () => {
        const stdout = [
            JSON.stringify({ path: "/a1/data/a.parquet", fields: { columnCount: 3 } }),
            JSON.stringify({ path: "/a1/data/b.h5ad", fields: { columnCount: 5 } }),
            '{"path": "/a1/data/c.loom", "fie',
        ].join("\n");
        const readouts = await readHeaders({
            ...enrichArgs({
                shapes: [],
                fs: readSeam({}).fs,
                sandboxClient: failingSandbox({ stdout }),
                sandbox: { sandboxId: "s1", host: "127.0.0.1", port: 8080, backend: "docker" },
            }),
            targets: [
                { path: "data/a.parquet", format: "parquet" },
                { path: "data/b.h5ad", format: "h5ad" },
                { path: "data/c.loom", format: "loom" },
            ],
        });

        expect(readouts.get("data/a.parquet")?.fields).toEqual({ columnCount: 3 });
        expect(readouts.get("data/b.h5ad")?.fields).toEqual({ columnCount: 5 });
        expect(readouts.get("data/c.loom")?.unavailable).toBe("container decoder reported nothing for this member");
    });

    it("names the cut output when the sandbox capped the decoder stdout", async () => {
        const stdout = [JSON.stringify({ path: "/a1/data/a.parquet", fields: { columnCount: 3 } }), '{"path": "/a1/data/b.h5ad", "fie'].join("\n");
        const readouts = await readHeaders({
            ...enrichArgs({
                shapes: [],
                fs: readSeam({}).fs,
                sandboxClient: failingSandbox({ stdout, stdoutTruncated: true }),
                sandbox: { sandboxId: "s1", host: "127.0.0.1", port: 8080, backend: "docker" },
            }),
            targets: [
                { path: "data/a.parquet", format: "parquet" },
                { path: "data/b.h5ad", format: "h5ad" },
            ],
        });

        expect(readouts.get("data/a.parquet")?.fields).toEqual({ columnCount: 3 });
        expect(readouts.get("data/b.h5ad")?.unavailable).toBe("container decoder output was cut at the sandbox byte cap");
    });

    it("names the cut output for a path that the capped stdout never reached", async () => {
        const stdout = JSON.stringify({ path: "/a1/data/a.parquet", fields: { columnCount: 3 } });
        const readouts = await readHeaders({
            ...enrichArgs({
                shapes: [],
                fs: readSeam({}).fs,
                sandboxClient: failingSandbox({ stdout, stdoutTruncated: true }),
                sandbox: { sandboxId: "s1", host: "127.0.0.1", port: 8080, backend: "docker" },
            }),
            targets: [
                { path: "data/a.parquet", format: "parquet" },
                { path: "data/b.h5ad", format: "h5ad" },
            ],
        });

        expect(readouts.get("data/b.h5ad")?.unavailable).toBe("container decoder output was cut at the sandbox byte cap");
    });

    it("names the cut output together with a non-zero exit of the decoder", async () => {
        const readouts = await readHeaders({
            ...enrichArgs({
                shapes: [],
                fs: readSeam({}).fs,
                sandboxClient: failingSandbox({ stdout: "", stdoutTruncated: true, exitCode: 2, stderr: "boom" }),
                sandbox: { sandboxId: "s1", host: "127.0.0.1", port: 8080, backend: "docker" },
            }),
            targets: [{ path: "data/b.h5ad", format: "h5ad" }],
        });

        const reason = readouts.get("data/b.h5ad")?.unavailable;
        expect(reason).toContain("container decoder exited 2: boom");
        expect(reason).toContain("container decoder output was cut at the sandbox byte cap");
    });

    it("names the cut output together with a timeout of the decoder", async () => {
        const readouts = await readHeaders({
            ...enrichArgs({
                shapes: [],
                fs: readSeam({}).fs,
                sandboxClient: failingSandbox({ stdout: "", stdoutTruncated: true, timedOut: true, exitCode: null }),
                sandbox: { sandboxId: "s1", host: "127.0.0.1", port: 8080, backend: "docker" },
            }),
            targets: [{ path: "data/b.h5ad", format: "h5ad" }],
        });

        const reason = readouts.get("data/b.h5ad")?.unavailable;
        expect(reason).toContain("container decoder timed out after");
        expect(reason).toContain("container decoder output was cut at the sandbox byte cap");
    });

    it("issues nothing when there is nothing to read", async () => {
        const { fs, reads } = readSeam({});
        const { client, submitted } = recordingSandbox();

        const shapes = await enrichShapes(
            enrichArgs({ shapes: [], fs, sandboxClient: client, sandbox: { sandboxId: "s1", host: "127.0.0.1", port: 8080, backend: "docker" } }),
        );

        expect(shapes).toEqual([]);
        expect(reads).toEqual([]);
        expect(submitted).toEqual([]);
    });
});
