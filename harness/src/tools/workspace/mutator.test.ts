/**
 * `WorkspaceMutator` provenance-recording contract — the seam records a
 * file-tool provenance record on a successful confined write and stays silent
 * on every non-ok outcome and when no collector is wired.
 *
 * These assertions are about the in-process collector; the write itself lands
 * on the host filesystem under a per-test temp tree.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeSession } from "../../providers/__fixtures__/session.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createSessionWorkspaceMutator, createWorkspaceMutator } from "./mutator.js";
import { createEditFileTool } from "./edit-file.js";
import { createWriteFileTool } from "./write-file.js";
import { ProvenanceCollector } from "../../provenance/collector.js";
import type { SessionProvenanceEvent } from "../../provenance/seam.js";
import { computeSha256 } from "../../lib/fs-helpers.js";
import { createWorkspaceFilesystem } from "../../workspace/filesystem.js";
import { stepWritePrefix } from "../../workspace/paths.js";
import type { RunStep } from "../../loop/types.js";

const ANALYSIS = "analysis-001";
const RUN = "run-abc";
const STEP = "step-1";

const passthrough: RunStep = (_name, fn) => fn();
const session = makeSession({ scope: { kind: "analysis", analysisId: ANALYSIS } });

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
        const result = await mutator.writeFile({ path: "output/x.csv", content, toolName: "write_file", runStep: passthrough, session });
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
            session,
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
            session,
        });
        expect(prefixed.status).toBe("out_of_prefix");
        expect(prefixCollector.getRecords()).toHaveLength(0);
    });

    test("a collector-less mutator writes successfully and records nothing (result unchanged)", async () => {
        const mutator = buildMutator();
        const content = "id,value\n1,42\n";
        const result = await mutator.writeFile({ path: "output/x.csv", content, toolName: "write_file", runStep: passthrough, session });
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

        await mutator.writeFile({ path: "output/notes.md", content: "# notes\n", toolName: "write_file", runStep: passthrough, session });

        const records = collector.getRecords();
        expect(records).toHaveLength(1);
        expect(records.every((r) => r.producer.type !== "command")).toBe(true);
        expect(records[0]!.producer.type).toBe("file_tool");
    });
});

// The conversation agent's write path: coordinates resolve per call from the
// session's analysis scope, the write prefix is the analysis root, and each
// successful write emits one `write-file` provenance session event.
describe("createSessionWorkspaceMutator (chat context)", () => {
    let basePath: string;

    beforeEach(() => {
        basePath = mkdtempSync(join(tmpdir(), "session-mutator-test-"));
    });
    afterEach(() => {
        rmSync(basePath, { recursive: true, force: true });
    });

    function buildSessionMutator() {
        const events: SessionProvenanceEvent[] = [];
        const mutator = createSessionWorkspaceMutator({
            resolveWorkspaceRoot: (id) => join(basePath, id),
            provenance: { emitSessionEvent: (event) => events.push(event) },
        });
        return { mutator, events };
    }

    const chatSession = makeSession({ scope: { kind: "analysis", analysisId: ANALYSIS, threadId: "thread-1" } });

    test("a write lands anywhere inside the analysis tree and emits a write-file event with hash, size, and attribution", async () => {
        const { mutator, events } = buildSessionMutator();
        const content = "# notes\n";
        const contentBytes = Buffer.from(content, "utf8");

        const result = await mutator.writeFile({ path: "notes/summary.md", content, toolName: "write_file", runStep: passthrough, session: chatSession });
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
            expect(result.path).toBe(`/${ANALYSIS}/notes/summary.md`);
            expect(result.bytesWritten).toBe(contentBytes.length);
        }
        expect(readFileSync(join(basePath, ANALYSIS, "notes", "summary.md"), "utf8")).toBe(content);

        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            type: "write-file",
            analysisId: ANALYSIS,
            threadId: "thread-1",
            path: "notes/summary.md",
            hash: computeSha256(contentBytes),
            size: contentBytes.length,
            tool: "write_file",
        });
    });

    test("a scope with no thread emits the event with no threadId key", async () => {
        const { mutator, events } = buildSessionMutator();
        const bare = makeSession({ scope: { kind: "analysis", analysisId: ANALYSIS } });

        const result = await mutator.writeFile({ path: "notes/a.md", content: "a", toolName: "edit_file", runStep: passthrough, session: bare });
        expect(result.status).toBe("ok");
        expect(events).toHaveLength(1);
        expect(events[0]).not.toHaveProperty("threadId");
        expect(events[0]).toMatchObject({ type: "write-file", tool: "edit_file" });
    });

    test("a traversal escape and a foreign analysis are out_of_scope, land nothing, and emit nothing", async () => {
        const { mutator, events } = buildSessionMutator();

        const escaped = await mutator.writeFile({ path: "../outside/x.csv", content: "x", toolName: "write_file", runStep: passthrough, session: chatSession });
        expect(escaped.status).toBe("out_of_scope");

        const foreign = await mutator.writeFile({
            path: "/other-analysis/x.csv",
            content: "x",
            toolName: "write_file",
            runStep: passthrough,
            session: chatSession,
        });
        expect(foreign.status).toBe("out_of_scope");

        expect(existsSync(join(basePath, "outside"))).toBe(false);
        expect(existsSync(join(basePath, "other-analysis"))).toBe(false);
        expect(events).toHaveLength(0);
    });

    test("a symlinked ancestor that escapes the analysis root is refused and emits nothing", async () => {
        const { mutator, events } = buildSessionMutator();
        const outside = join(basePath, "outside-tree");
        await mkdir(outside, { recursive: true });
        await mkdir(join(basePath, ANALYSIS), { recursive: true });
        await symlink(outside, join(basePath, ANALYSIS, "leak"));

        const result = await mutator.writeFile({ path: "leak/x.csv", content: "x", toolName: "write_file", runStep: passthrough, session: chatSession });
        expect(result.status).toBe("out_of_prefix");
        expect(existsSync(join(outside, "x.csv"))).toBe(false);
        expect(events).toHaveLength(0);
    });

    test("a non-analysis scope is out_of_scope before any I/O", async () => {
        const { mutator, events } = buildSessionMutator();
        const assessment = makeSession({ scope: { kind: "target-assessment", targetAssessmentId: "ta-1", billingContextId: "bc-1" } });

        const result = await mutator.writeFile({ path: "x.csv", content: "x", toolName: "write_file", runStep: passthrough, session: assessment });
        expect(result.status).toBe("out_of_scope");
        expect(events).toHaveLength(0);
    });

    test("an unbound provenance seam records nothing and the write proceeds unchanged", async () => {
        const mutator = createSessionWorkspaceMutator({ resolveWorkspaceRoot: (id) => join(basePath, id) });
        const result = await mutator.writeFile({ path: "notes/b.md", content: "b", toolName: "write_file", runStep: passthrough, session: chatSession });
        expect(result.status).toBe("ok");
        expect(readFileSync(join(basePath, ANALYSIS, "notes", "b.md"), "utf8")).toBe("b");
    });

    test("write_file and edit_file through the real tool path land and emit in a chat ToolContext", async () => {
        const { mutator, events } = buildSessionMutator();
        const writeTool = createWriteFileTool({ mutator });
        const fs = createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => join(basePath, id) });
        // No workingDir: the read seam defaults to the analysis root, matching
        // the session-scoped mutator's write prefix.
        const editTool = createEditFileTool({ mutator, workspaceFilesystem: fs });
        const { ctx } = makeToolContext();

        const written = (await writeTool.execute({ path: "notes/draft.md", content: "alpha beta\n" }, ctx))._unsafeUnwrap();
        expect(written.status).toBe("ok");

        const edited = (
            await editTool.execute({ path: "notes/draft.md", old_string: "beta", new_string: "gamma", replace_all: false, regex: false }, ctx)
        )._unsafeUnwrap();
        expect(edited.status).toBe("ok");
        expect(readFileSync(join(basePath, "analysis-001", "notes", "draft.md"), "utf8")).toBe("alpha gamma\n");

        expect(events.map((event) => (event.type === "write-file" ? event.tool : event.type))).toEqual(["write_file", "edit_file"]);
        const editEvent = events[1]!;
        if (editEvent.type === "write-file") {
            expect(editEvent.hash).toBe(computeSha256(Buffer.from("alpha gamma\n", "utf8")));
            expect(editEvent.size).toBe(Buffer.byteLength("alpha gamma\n", "utf8"));
        }
    });
});
