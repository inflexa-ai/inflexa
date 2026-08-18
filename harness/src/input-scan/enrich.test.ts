import { describe, expect, it } from "bun:test";

import type { SandboxClient } from "../sandbox/client.js";
import type { ExecResult, SubmitExecBody } from "../sandbox/types.js";
import { MEMBERS_DECODED_PER_SHAPE, enrichShapes } from "./enrich.js";
import { observeShapes } from "./shapes.js";
import type { ScannedFile } from "./types.js";

function file(path: string, format: string): ScannedFile {
    const base = path.slice(path.lastIndexOf("/") + 1);
    const dot = base.indexOf(".");
    return { path, size: 4096, extensions: dot <= 0 ? [] : base.slice(dot + 1).split("."), format };
}

/** 3513 files across four shapes — the tree that motivated the capability. */
function motivatingTree(): ScannedFile[] {
    const pad = (n: number) => String(n).padStart(4, "0");
    return [
        ...Array.from({ length: 1171 }, (_, i) => file(`data/inputs/vcf/PATIENT_${pad(i + 1)}.vcf.gz`, "vcf")),
        ...Array.from({ length: 1171 }, (_, i) => file(`data/inputs/tbi/PATIENT_${pad(i + 1)}.vcf.gz.tbi`, "tabix-index")),
        ...Array.from({ length: 1168 }, (_, i) => file(`data/inputs/bam/SAMPLE_${pad(i + 1)}.bam`, "bam")),
        ...Array.from({ length: 3 }, (_, i) => file(`data/inputs/meta/sheet_${i + 1}.csv`, "csv")),
    ];
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

describe("enrichShapes", () => {
    it("decodes per shape, not per file", async () => {
        const observed = observeShapes(motivatingTree());
        const { client, submitted } = recordingSandbox();

        const shapes = await enrichShapes({
            shapes: observed.shapes,
            sandboxClient: client,
            sandbox: { id: "s1" } as never,
            mountRoot: "/a1",
            execId: "wf:profile:fn-0",
            deadlineMs: Date.now() + 60_000,
            emit: async () => {},
        });

        expect(observed.shapes).toHaveLength(4);
        expect(submitted).toHaveLength(1);
        const decodedPaths = submitted[0]!.command.slice(3);
        expect(decodedPaths).toHaveLength(observed.shapes.length * MEMBERS_DECODED_PER_SHAPE);
        expect(decodedPaths.length).toBeLessThan(10);
        expect(shapes.every((shape) => shape.header !== undefined)).toBe(true);
        expect(shapes[0]!.header!.path.startsWith("data/inputs/")).toBe(true);
    });

    it("issues no exec when there is nothing to decode", async () => {
        const { client, submitted } = recordingSandbox();
        const shapes = await enrichShapes({
            shapes: [],
            sandboxClient: client,
            sandbox: { id: "s1" } as never,
            mountRoot: "/a1",
            execId: "wf:profile:fn-0",
            deadlineMs: Date.now() + 60_000,
            emit: async () => {},
        });
        expect(shapes).toEqual([]);
        expect(submitted).toHaveLength(0);
    });

    it("keeps every shape when the decoder returns nothing usable", async () => {
        const observed = observeShapes(motivatingTree());
        const client = {
            async submitExec() {},
            async awaitExec(_ref: unknown, execId: string): Promise<ExecResult> {
                return { execId, exitCode: 1, stdout: "", stderr: "python3: not found", durationMs: 1, timedOut: false };
            },
        } as unknown as SandboxClient;

        const shapes = await enrichShapes({
            shapes: observed.shapes,
            sandboxClient: client,
            sandbox: { id: "s1" } as never,
            mountRoot: "/a1",
            execId: "wf:profile:fn-0",
            deadlineMs: Date.now() + 60_000,
            emit: async () => {},
        });

        expect(shapes).toHaveLength(observed.shapes.length);
        expect(shapes.every((shape) => shape.header === undefined)).toBe(true);
    });
});
