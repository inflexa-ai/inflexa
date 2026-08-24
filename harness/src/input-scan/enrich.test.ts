import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";

import type { SandboxClient } from "../sandbox/client.js";
import type { ExecResult, SubmitExecBody } from "../sandbox/types.js";
import type { ReadBytesResult, WorkspaceFilesystem } from "../workspace/filesystem.js";
import { MEMBERS_DECODED_PER_SHAPE, enrichShapes } from "./enrich.js";
import { observeShapes } from "./shapes.js";
import type { ScannedFile } from "./types.js";

const SESSION = {} as never;

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
        ...Array.from({ length: 1168 }, (_, i) => file(`data/inputs/bam/SAMPLE_${pad(i + 1)}.bam`, "bam")),
        ...Array.from({ length: 3 }, (_, i) => file(`data/inputs/meta/sheet_${i + 1}.csv`, "csv")),
    ];
}

/** A read seam over an in-memory tree; every read is recorded with its byte budget. */
function readSeam(contents: Record<string, Buffer>): { fs: WorkspaceFilesystem; reads: { path: string; length: number }[] } {
    const reads: { path: string; length: number }[] = [];
    const fs = {
        readBytes({ path, length }: { path: string; length: number }) {
            reads.push({ path, length });
            const bytes = contents[path];
            return okAsync<ReadBytesResult, never>(bytes ? { kind: "ok", bytes: bytes.subarray(0, length) } : { kind: "not_found" });
        },
    } as unknown as WorkspaceFilesystem;
    return { fs, reads };
}

function recordingSandbox(): { client: SandboxClient; submitted: SubmitExecBody[] } {
    const submitted: SubmitExecBody[] = [];
    const client = {
        async submitExec(_ref: unknown, body: SubmitExecBody) {
            submitted.push(body);
        },
        async awaitExec(_ref: unknown, execId: string): Promise<ExecResult> {
            const paths = submitted.at(-1)!.command.slice(3);
            const stdout = paths.map((path) => JSON.stringify({ path, fields: { columnCount: 7 } })).join("\n");
            return { execId, exitCode: 0, stdout, stderr: "", durationMs: 5, timedOut: false };
        },
    } as unknown as SandboxClient;
    return { client, submitted };
}

function enrichArgs(overrides: Record<string, unknown>) {
    return {
        session: SESSION,
        mountRoot: "/a1",
        execId: "wf:profile:fn-0",
        deadlineMs: Date.now() + 60_000,
        emit: async () => {},
        ...overrides,
    } as Parameters<typeof enrichShapes>[0];
}

describe("enrichShapes", () => {
    it("reads one member per shape, not one per file, and never touches the sandbox for them", async () => {
        const observed = observeShapes(motivatingTree());
        const { fs, reads } = readSeam({});
        const { client, submitted } = recordingSandbox();

        const shapes = await enrichShapes(enrichArgs({ shapes: observed.shapes, fs, sandboxClient: client, sandbox: { id: "s1" } }));

        expect(observed.shapes).toHaveLength(4);
        expect(reads).toHaveLength(observed.shapes.length * MEMBERS_DECODED_PER_SHAPE);
        expect(reads.length).toBeLessThan(10);
        expect(submitted).toHaveLength(0);
        expect(shapes.every((shape) => shape.header !== undefined)).toBe(true);
        expect(shapes[0]!.header!.path.startsWith("data/inputs/")).toBe(true);
    });

    it("reads a header in process, with no sandbox wired at all", async () => {
        const observed = observeShapes([file("data/inputs/meta/sheet_1.csv", "csv"), file("data/inputs/meta/sheet_2.csv", "csv")]);
        const { fs } = readSeam({ "data/inputs/meta/sheet_1.csv": Buffer.from("subject,arm,dose\nS1,a,10\n") });

        const shapes = await enrichShapes(enrichArgs({ shapes: observed.shapes, fs }));

        expect(shapes[0]!.header!.fields).toMatchObject({ delimiter: "comma", columnCount: 3, columns: "subject, arm, dose" });
    });

    it("bounds the read it issues per member", async () => {
        const observed = observeShapes([file("data/inputs/meta/sheet_1.csv", "csv"), file("data/inputs/meta/sheet_2.csv", "csv")]);
        const { fs, reads } = readSeam({});

        await enrichShapes(enrichArgs({ shapes: observed.shapes, fs }));

        expect(reads[0]!.length).toBe(262_144);
    });

    it("notes an unreadable member instead of dropping its shape", async () => {
        const observed = observeShapes([file("data/inputs/meta/sheet_1.csv", "csv"), file("data/inputs/meta/sheet_2.csv", "csv")]);
        const { fs } = readSeam({});

        const shapes = await enrichShapes(enrichArgs({ shapes: observed.shapes, fs }));

        expect(shapes[0]!.header!.unavailable).toBe("prefix unreadable (not_found)");
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

        const shapes = await enrichShapes(enrichArgs({ shapes: observed.shapes, fs, sandboxClient: client, sandbox: { id: "s1" } }));

        expect(submitted).toHaveLength(1);
        expect(submitted[0]!.command.slice(3)).toEqual(["/a1/data/inputs/tables/counts_1.parquet"]);
        expect(submitted[0]!.command[0]).toBe("python3");
        expect(submitted[0]!.command[2]).toContain("def parquet_fields(");
        const parquet = shapes.find((shape) => shape.format === "parquet")!;
        expect(parquet.header!.fields).toEqual({ columnCount: 7 });
        expect(parquet.header!.path).toBe("data/inputs/tables/counts_1.parquet");
    });

    it("skips the container readout when no sandbox is wired, keeping the shape", async () => {
        const observed = observeShapes([file("data/inputs/tables/counts_1.parquet", "parquet"), file("data/inputs/tables/counts_2.parquet", "parquet")]);
        const { fs } = readSeam({});

        const shapes = await enrichShapes(enrichArgs({ shapes: observed.shapes, fs }));

        expect(shapes).toHaveLength(1);
        expect(shapes[0]!.header).toBeUndefined();
    });

    it("notes a container the decoder said nothing about", async () => {
        const observed = observeShapes([file("data/inputs/tables/counts_1.parquet", "parquet"), file("data/inputs/tables/counts_2.parquet", "parquet")]);
        const { fs } = readSeam({});
        const client = {
            async submitExec() {},
            async awaitExec(_ref: unknown, execId: string): Promise<ExecResult> {
                return { execId, exitCode: 1, stdout: "", stderr: "python3: not found", durationMs: 1, timedOut: false };
            },
        } as unknown as SandboxClient;

        const shapes = await enrichShapes(enrichArgs({ shapes: observed.shapes, fs, sandboxClient: client, sandbox: { id: "s1" } }));

        expect(shapes[0]!.header!.unavailable).toBe("container decoder reported nothing for this member");
    });

    it("issues nothing when there is nothing to read", async () => {
        const { fs, reads } = readSeam({});
        const { client, submitted } = recordingSandbox();

        const shapes = await enrichShapes(enrichArgs({ shapes: [], fs, sandboxClient: client, sandbox: { id: "s1" } }));

        expect(shapes).toEqual([]);
        expect(reads).toHaveLength(0);
        expect(submitted).toHaveLength(0);
    });
});
