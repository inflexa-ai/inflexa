import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import {
    acquireScriptSlot,
    DECODE_WORKER_HEAP_MIB,
    DECODE_WORKER_SLOTS,
    HOST_WORKER_MEMORY_MIB,
    hostWorkerSlotsForTest,
    runHostTask,
    SCRIPT_VM_MEMORY_MIB,
    SCRIPT_WORKER_HEAP_MIB,
    SCRIPT_WORKER_SLOTS,
    setHostWorkerEntry,
    withDecodeSlot,
} from "../host-workers.js";
import type { HostTask } from "../../workspace/decode-tasks.js";
import { parseJsonAs } from "../parse-json.js";

function csvBuffer(text: string): ArrayBuffer {
    return new TextEncoder().encode(text).buffer;
}

function tableTask(bytes: ArrayBuffer): HostTask {
    return { kind: "table", bytes, path: "t.csv", format: "csv", options: { cellBudget: 1_000_000, numericText: true } };
}

describe("the heavy workers", () => {
    test("a decode task runs in a worker, and the bytes move to it", async () => {
        const bytes = csvBuffer("gene,padj,id\nTP53,0.001,007\nFLT3,0.2,12\nKRAS,0.3,5\n");

        const result = await runHostTask(
            {
                kind: "table",
                bytes,
                path: "t.csv",
                format: "csv",
                options: { columns: ["gene", "padj"], offset: 1, limit: 1, cellBudget: 10, numericText: true },
            },
            { transfer: [bytes] },
        );

        expect(result._unsafeUnwrap()).toEqual({ kind: "rows", columns: ["gene", "padj"], rows: [{ gene: "FLT3", padj: 0.2 }], totalRows: 3 });
        expect(bytes.byteLength).toBe(0);
    });

    test("a decode past the free slots waits, and each slot is free after the decodes", async () => {
        const text = `a,b\n${"1,2\n".repeat(50_000)}`;
        const tasks = Array.from({ length: DECODE_WORKER_SLOTS + 1 }, () => runHostTask(tableTask(csvBuffer(text))));
        await Promise.resolve();

        expect(hostWorkerSlotsForTest().decode).toEqual({ inUse: DECODE_WORKER_SLOTS, waiting: 1 });
        const results = await Promise.all(tasks);

        expect(results.map((result) => result.isOk() && result.value.kind)).toEqual(Array.from({ length: DECODE_WORKER_SLOTS + 1 }, () => "rows"));
        expect(hostWorkerSlotsForTest().decode).toEqual({ inUse: 0, waiting: 0 });
    });

    test("a worker that does not start is crashed, and its slot is free", async () => {
        setHostWorkerEntry(new URL("./no-such-worker.js", import.meta.url));
        try {
            const result = await runHostTask(tableTask(csvBuffer("a\n1\n")));

            expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "crashed" });
            expect(hostWorkerSlotsForTest().decode).toEqual({ inUse: 0, waiting: 0 });
        } finally {
            setHostWorkerEntry(undefined);
        }
    });

    test("an abort ends the task", async () => {
        const controller = new AbortController();
        controller.abort();

        expect((await runHostTask(tableTask(csvBuffer("a\n1\n")), { signal: controller.signal }))._unsafeUnwrapErr()).toEqual({ kind: "aborted" });
    });

    test("a body holds its decode slot from before its read to the end of its decode", async () => {
        const releases: Array<() => void> = [];
        const holding = Array.from({ length: DECODE_WORKER_SLOTS }, () =>
            withDecodeSlot(undefined, () => new Promise<void>((resolve) => releases.push(resolve))),
        );
        let read = false;
        const waiting = withDecodeSlot(undefined, (run) => {
            read = true;
            return Promise.resolve(run(tableTask(csvBuffer("a\n1\n"))));
        });
        await Promise.resolve();

        expect(read).toBe(false);
        expect(hostWorkerSlotsForTest().decode).toEqual({ inUse: DECODE_WORKER_SLOTS, waiting: 1 });
        releases[0]?.();
        expect((await waiting)._unsafeUnwrap()._unsafeUnwrap()).toMatchObject({ kind: "rows" });
        expect(read).toBe(true);
        for (const release of releases) release();
        await Promise.all(holding);
        expect(hostWorkerSlotsForTest().decode).toEqual({ inUse: 0, waiting: 0 });
    });

    test("a cancel while a read waits for a slot leaves the queue, and the read does not run", async () => {
        const releases: Array<() => void> = [];
        const holding = Array.from({ length: DECODE_WORKER_SLOTS }, () =>
            withDecodeSlot(undefined, () => new Promise<void>((resolve) => releases.push(resolve))),
        );
        const controller = new AbortController();
        let read = false;
        const waiting = withDecodeSlot(controller.signal, () => {
            read = true;
            return Promise.resolve();
        });
        await Promise.resolve();

        controller.abort();

        expect((await waiting)._unsafeUnwrapErr()).toEqual({ kind: "aborted" });
        expect(read).toBe(false);
        expect(hostWorkerSlotsForTest().decode).toEqual({ inUse: DECODE_WORKER_SLOTS, waiting: 0 });
        for (const release of releases) release();
        await Promise.all(holding);
        expect(hostWorkerSlotsForTest().decode).toEqual({ inUse: 0, waiting: 0 });
    });

    test("a script past the free script slots waits for one", async () => {
        const held = await Promise.all(Array.from({ length: SCRIPT_WORKER_SLOTS }, () => acquireScriptSlot()));
        let started = false;
        const waiting = acquireScriptSlot().then((free) => {
            started = true;
            return free;
        });
        await Promise.resolve();

        expect(started).toBe(false);
        held[0]?.();
        const free = await waiting;
        expect(started).toBe(true);
        free();
        for (const release of held.slice(1)) release();
        expect(hostWorkerSlotsForTest().script).toEqual({ inUse: 0, waiting: 0 });
    });

    test("the memory budget is the sum of the limits of each slot", () => {
        const young = 16;
        expect(HOST_WORKER_MEMORY_MIB).toBe(
            DECODE_WORKER_SLOTS * (DECODE_WORKER_HEAP_MIB + young) + SCRIPT_WORKER_SLOTS * (SCRIPT_WORKER_HEAP_MIB + young + SCRIPT_VM_MEMORY_MIB),
        );
    });
});

const node = Bun.which("node");
const built = mkdtempSync(join(tmpdir(), "host-workers-node-"));
afterAll(() => rmSync(built, { recursive: true, force: true }));

// Bun accepts `resourceLimits` and does not enforce it, thus the heap limit is a fact of Node only.
describe.skipIf(node === null)("the heavy workers under Node", () => {
    test("a decode past the heap of its worker fails as out_of_memory, and the process runs the next task", async () => {
        const driver = join(built, "driver.ts");
        await Bun.write(
            driver,
            `import { runHostTask, setHostWorkerEntry } from ${JSON.stringify(join(import.meta.dir, "../host-workers.ts"))};
setHostWorkerEntry(new URL("./codemode-worker.js", import.meta.url));
const wide = new TextEncoder().encode("a,b,c,d\\n" + "aaaaaaaa,bbbbbbbb,cccccccc,dddddddd\\n".repeat(400_000)).buffer;
const first = await runHostTask({ kind: "table", bytes: wide, path: "w.csv", format: "csv", options: { cellBudget: Infinity, numericText: false } }, { transfer: [wide], heapMib: 32 });
const small = new TextEncoder().encode("a\\n1\\n").buffer;
const second = await runHostTask({ kind: "table", bytes: small, path: "s.csv", format: "csv", options: { cellBudget: 10, numericText: true } }, { transfer: [small] });
console.log(JSON.stringify({ first: first.isErr() ? first.error : "rows", second: second.isOk() ? second.value : second.error }));
`,
        );
        const build = await Bun.build({
            entrypoints: [driver, join(import.meta.dir, "../../tools/script/codemode-worker.ts")],
            outdir: built,
            target: "node",
            format: "esm",
            naming: "[name].js",
        });
        expect(build.success).toBe(true);

        const child = Bun.spawnSync({ cmd: [node ?? "node", join(built, "driver.js")] });

        expect(child.exitCode).toBe(0);
        expect(parseJsonAs(child.stdout.toString(), z.json())).toEqual({
            first: { kind: "out_of_memory" },
            second: { kind: "rows", columns: ["a"], rows: [{ a: 1 }], totalRows: 1 },
        });
    }, 60_000);
});
