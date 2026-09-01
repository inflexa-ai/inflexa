/**
 * `WorkspaceMutator` provenance-recording contract — the seam records a
 * file-tool provenance record on a successful confined write and stays silent
 * on every non-ok outcome and when no collector is wired.
 *
 * These assertions are about the in-process collector; the write itself lands
 * on the host filesystem under a per-test temp tree.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createWorkspaceMutator } from "./mutator.js";
import { createWriteFileTool } from "./write-file.js";
import { ProvenanceCollector } from "../../provenance/collector.js";
import { computeSha256 } from "../../lib/fs-helpers.js";
import { stepWritePrefix } from "../../workspace/paths.js";
import type { RunStep } from "../../loop/types.js";

const ANALYSIS = "analysis-001";
const RUN = "run-abc";
const STEP = "step-1";

const passthrough: RunStep = (_name, fn) => fn();

describe("WorkspaceMutator provenance recording", () => {
    let basePath: string;

    beforeEach(() => {
        basePath = mkdtempSync(join(tmpdir(), "mutator-test-"));
    });
    afterEach(() => {
        rmSync(basePath, { recursive: true, force: true });
    });

    function buildMutator(opts: { collector?: ProvenanceCollector } = {}) {
        const workspaceRoot = join(basePath, ANALYSIS);
        const workingDir = stepWritePrefix({ workspaceRoot, runId: RUN, stepId: STEP });
        return createWorkspaceMutator({
            workspaceRoot,
            analysisId: ANALYSIS,
            workingDir,
            ...(opts.collector ? { lineageCollector: opts.collector } : {}),
        });
    }

    test("a successful write records a file-tool producer with in-process hash + size and no inputs", async () => {
        const collector = new ProvenanceCollector({ stepId: STEP, runId: RUN });
        const mutator = buildMutator({ collector });

        const content = "id,value\n1,42\n";
        const contentBytes = Buffer.from(content, "utf8");
        const result = await mutator.writeFile({ path: "output/x.csv", content, toolName: "write_file", runStep: passthrough });
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

    test("out_of_scope and out_of_prefix writes record nothing", async () => {
        // Escapes the analysis tree entirely.
        const scopeCollector = new ProvenanceCollector({ stepId: STEP, runId: RUN });
        const scoped = await buildMutator({ collector: scopeCollector }).writeFile({
            path: "../../../../other/x.csv",
            content: "x",
            toolName: "write_file",
            runStep: passthrough,
        });
        expect(scoped.status).toBe("out_of_scope");
        expect(scopeCollector.getRecords()).toHaveLength(0);

        // In-tree but outside the step's writable working directory.
        const prefixCollector = new ProvenanceCollector({ stepId: STEP, runId: RUN });
        const prefixed = await buildMutator({ collector: prefixCollector }).writeFile({
            path: `/${ANALYSIS}/data/inputs/x.csv`,
            content: "x",
            toolName: "write_file",
            runStep: passthrough,
        });
        expect(prefixed.status).toBe("out_of_prefix");
        expect(prefixCollector.getRecords()).toHaveLength(0);
    });

    test("a collector-less mutator writes successfully and records nothing (result unchanged)", async () => {
        const mutator = buildMutator();
        const content = "id,value\n1,42\n";
        const result = await mutator.writeFile({ path: "output/x.csv", content, toolName: "write_file", runStep: passthrough });
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
            expect(result.bytesWritten).toBe(Buffer.byteLength(content, "utf8"));
            expect(result.path).toBe(`/${ANALYSIS}/runs/${RUN}/${STEP}/output/x.csv`);
        }
    });

    test("write_file through the real tool path records under the step-relative manifest key", async () => {
        const collector = new ProvenanceCollector({ stepId: STEP, runId: RUN });
        const mutator = buildMutator({ collector });
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

    test("a confined write mints no command record — the file-tool record is the sole attestation", async () => {
        const collector = new ProvenanceCollector({ stepId: STEP, runId: RUN });
        const mutator = buildMutator({ collector });

        await mutator.writeFile({ path: "output/notes.md", content: "# notes\n", toolName: "write_file", runStep: passthrough });

        const records = collector.getRecords();
        expect(records).toHaveLength(1);
        expect(records.every((r) => r.producer.type !== "command")).toBe(true);
        expect(records[0]!.producer.type).toBe("file_tool");
    });
});
