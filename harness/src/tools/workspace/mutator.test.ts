/**
 * `WorkspaceMutator` provenance-recording contract — the seam records a
 * file-tool provenance record on a successful confined write and stays silent
 * on every non-ok outcome and when no collector is wired.
 *
 * The fake `SandboxClient` never materialises files; these assertions are about
 * the in-process collector, not disk (path resolution + hashing are pure).
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createWorkspaceMutator } from "./mutator.js";
import { createWriteFileTool } from "./write-file.js";
import { ProvenanceCollector } from "../../provenance/collector.js";
import { computeSha256 } from "../../lib/fs-helpers.js";
import { stepWritePrefix, toSandboxPath } from "../../workspace/paths.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { ExecEmit, ExecResult, SandboxRef, SubmitExecBody } from "../../sandbox/types.js";

const ANALYSIS = "analysis-001";
const RUN = "run-abc";
const STEP = "step-1";

function makeSandboxRef(): SandboxRef {
    return { sandboxId: "sb-1", host: "127.0.0.1", port: 8765, backend: "docker", callbackSecret: "secret-abc" };
}

interface FakeClient extends SandboxClient {
    readonly submits: SubmitExecBody[];
}

/** A `SandboxClient` whose write exec returns `opts.exitCode` (default 0). */
function makeFakeClient(opts: { exitCode?: number } = {}): FakeClient {
    const submits: SubmitExecBody[] = [];
    const exitCode = opts.exitCode ?? 0;
    return {
        submits,
        async createSandbox() {
            return makeSandboxRef();
        },
        async submitExec(_ref: SandboxRef, body: SubmitExecBody) {
            submits.push(body);
        },
        async awaitExec(_ref: SandboxRef, execId: string, _emit: ExecEmit, _deadlineMs: number): Promise<ExecResult> {
            return { execId, exitCode, stdout: "", stderr: "", durationMs: 1, timedOut: false };
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

function buildMutator(opts: { client: SandboxClient; collector?: ProvenanceCollector }) {
    const workspaceRoot = join(tmpdir(), ANALYSIS);
    const workingDir = stepWritePrefix({ workspaceRoot, runId: RUN, stepId: STEP });
    return createWorkspaceMutator({
        sandboxClient: opts.client,
        sandbox: makeSandboxRef(),
        workspaceRoot,
        analysisId: ANALYSIS,
        stepId: STEP,
        workflowId: "wf1",
        workingDir,
        sandboxWorkingDir: toSandboxPath(workspaceRoot, ANALYSIS, workingDir),
        nextFunctionId: () => "fn1",
        deadlineMs: () => 9_999_999,
        ...(opts.collector ? { lineageCollector: opts.collector } : {}),
    });
}

const noopEmit = (): void => {};

describe("WorkspaceMutator provenance recording", () => {
    test("a successful write records a file-tool producer with in-process hash + size and no inputs", async () => {
        const collector = new ProvenanceCollector({ stepId: STEP, runId: RUN });
        const mutator = buildMutator({ client: makeFakeClient(), collector });

        const content = "id,value\n1,42\n";
        const contentBytes = Buffer.from(content, "utf8");
        const result = await mutator.writeFile({ path: "output/x.csv", content, toolName: "write_file", emit: noopEmit });
        expect(result.status).toBe("ok");

        const records = collector.getRecords();
        expect(records).toHaveLength(1);
        const rec = records[0]!;
        expect(rec.producer.type).toBe("file_tool");
        if (rec.producer.type === "file_tool") {
            expect(rec.producer.tool).toBe("write_file");
            expect(typeof rec.producer.timestamp).toBe("string");
        }
        expect(rec.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(rec.outputHash).toBe(computeSha256(contentBytes));
        expect(rec.outputSize).toBe(contentBytes.length);
        expect(rec.inputs).toEqual([]);
        expect(rec.outputPath).toBe("output/x.csv");
    });

    test("out_of_scope, out_of_prefix, and non-zero-exit writes record nothing", async () => {
        // Escapes the analysis tree entirely.
        const scopeCollector = new ProvenanceCollector({ stepId: STEP, runId: RUN });
        const scoped = await buildMutator({ client: makeFakeClient(), collector: scopeCollector }).writeFile({
            path: "../../../../other/x.csv",
            content: "x",
            toolName: "write_file",
            emit: noopEmit,
        });
        expect(scoped.status).toBe("out_of_scope");
        expect(scopeCollector.getRecords()).toHaveLength(0);

        // In-tree but outside the step's writable working directory.
        const prefixCollector = new ProvenanceCollector({ stepId: STEP, runId: RUN });
        const prefixed = await buildMutator({ client: makeFakeClient(), collector: prefixCollector }).writeFile({
            path: `/${ANALYSIS}/data/inputs/x.csv`,
            content: "x",
            toolName: "write_file",
            emit: noopEmit,
        });
        expect(prefixed.status).toBe("out_of_prefix");
        expect(prefixCollector.getRecords()).toHaveLength(0);

        // The sandbox write exec exits non-zero — no bytes landed.
        const failCollector = new ProvenanceCollector({ stepId: STEP, runId: RUN });
        const failed = await buildMutator({ client: makeFakeClient({ exitCode: 1 }), collector: failCollector }).writeFile({
            path: "output/x.csv",
            content: "x",
            toolName: "write_file",
            emit: noopEmit,
        });
        expect(failed.status).toBe("write_failed");
        expect(failCollector.getRecords()).toHaveLength(0);
    });

    test("a collector-less mutator writes successfully and records nothing (result unchanged)", async () => {
        const mutator = buildMutator({ client: makeFakeClient() });
        const content = "id,value\n1,42\n";
        const result = await mutator.writeFile({ path: "output/x.csv", content, toolName: "write_file", emit: noopEmit });
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
            expect(result.bytesWritten).toBe(Buffer.byteLength(content, "utf8"));
            expect(result.path).toBe(`/${ANALYSIS}/runs/${RUN}/${STEP}/output/x.csv`);
        }
    });

    test("write_file through the real tool path records under the step-relative manifest key", async () => {
        const collector = new ProvenanceCollector({ stepId: STEP, runId: RUN });
        const mutator = buildMutator({ client: makeFakeClient(), collector });
        const tool = createWriteFileTool({ mutator });
        const { ctx } = makeToolContext();

        const out = (await tool.execute({ path: "output/notes.md", content: "# notes\n" }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("ok");

        // The key a manifest entry would use — `output/notes.md`, not a record-less leaf.
        const records = collector.getRecords();
        expect(records).toHaveLength(1);
        const rec = records[0]!;
        expect(rec.outputPath).toBe("output/notes.md");
        expect(rec.producer.type).toBe("file_tool");
        if (rec.producer.type === "file_tool") expect(rec.producer.tool).toBe("write_file");
    });

    test("the mutate seam's own exec frame never becomes a command record", async () => {
        const collector = new ProvenanceCollector({ stepId: STEP, runId: RUN });
        const mutator = buildMutator({ client: makeFakeClient(), collector });

        await mutator.writeFile({ path: "output/notes.md", content: "# notes\n", toolName: "write_file", emit: noopEmit });

        // The write exec is never threaded through `feedExecFrame`, so no command
        // record naming the `python3` write interpreter exists for the path — the
        // in-process file-tool record is the sole attestation.
        const records = collector.getRecords();
        expect(records).toHaveLength(1);
        expect(records.every((r) => r.producer.type !== "command")).toBe(true);
        expect(records[0]!.producer.type).toBe("file_tool");
    });
});
