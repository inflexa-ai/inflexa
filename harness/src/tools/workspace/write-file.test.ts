import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createReadFileTool } from "./read-file.js";
import { createWriteFileTool } from "./write-file.js";
import { createWorkspaceMutator } from "./mutator.js";
import { createWorkspaceFilesystem } from "../../workspace/filesystem.js";
import { stepWritePrefix } from "../../workspace/paths.js";

const ANALYSIS = "analysis-001";
const RUN = "run-abc";
const STEP = "step-1";

describe("write_file tool", () => {
    let sessionsBasePath: string;

    beforeEach(() => {
        sessionsBasePath = mkdtempSync(join(tmpdir(), "wf-test-"));
    });
    afterEach(() => {
        rmSync(sessionsBasePath, { recursive: true, force: true });
    });

    function workingDirOf() {
        return stepWritePrefix({ workspaceRoot: join(sessionsBasePath, ANALYSIS), runId: RUN, stepId: STEP });
    }

    function buildTool() {
        const workspaceRoot = join(sessionsBasePath, ANALYSIS);
        const workingDir = workingDirOf();
        const mutator = createWorkspaceMutator({
            workspaceRoot,
            analysisId: ANALYSIS,
            workingDir,
        });
        const tool = createWriteFileTool({ mutator });
        return { tool, workingDir };
    }

    it("writes a file inside the prefix and the read surface returns the same content at the same path", async () => {
        const { tool } = buildTool();
        const { ctx } = makeToolContext();

        const out = (await tool.execute({ path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/result.csv`, content: "id,value\n1,42\n" }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("ok");

        const fs = createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => join(sessionsBasePath, id) });
        const readTool = createReadFileTool(fs);
        const read = (await readTool.execute({ path: `runs/${RUN}/${STEP}/output/result.csv` }, ctx))._unsafeUnwrap();
        expect(read.status).toBe("ok");
        if (read.status === "ok") {
            expect(read.content).toBe("id,value\n1,42\n");
        }
    });

    it("a relative path resolves INTO the working dir (step dir), creating the missing parent dirs inside the prefix", async () => {
        const { tool, workingDir } = buildTool();
        const { ctx } = makeToolContext();

        // Nothing under the step dir exists yet — the landing creates
        // `output/deep` inside the prefix.
        const out = (await tool.execute({ path: "output/deep/x.csv", content: "id,value\n1,42\n" }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("ok");
        if (out.status === "ok") {
            expect(out.path).toBe(`/${ANALYSIS}/runs/${RUN}/${STEP}/output/deep/x.csv`);
        }

        const onDisk = await readFile(join(workingDir, "output", "deep", "x.csv"), "utf8");
        expect(onDisk).toBe("id,value\n1,42\n");
    });

    it("rejects an absolute write under data/inputs as out_of_prefix and lands no file", async () => {
        const { tool } = buildTool();
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ path: `/${ANALYSIS}/data/inputs/x.csv`, content: "evil" }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("out_of_prefix");
        expect(existsSync(join(sessionsBasePath, ANALYSIS, "data", "inputs", "x.csv"))).toBe(false);
    });

    it("rejects a `..` escape out of the analysis tree as out_of_scope and lands no file", async () => {
        // workingDir is the step dir (runs/run-abc/step-1); four `..` reach the
        // analysis root and a fifth escapes it.
        const { tool } = buildTool();
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ path: "../../../../analysis-002/x.csv", content: "evil" }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("out_of_scope");
        expect(existsSync(join(sessionsBasePath, "analysis-002"))).toBe(false);
    });

    it("rejects a write into another analysis's tree as out_of_scope", async () => {
        const { tool } = buildTool();
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ path: "/analysis-002/runs/x.csv", content: "evil" }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("out_of_scope");
        expect(existsSync(join(sessionsBasePath, "analysis-002"))).toBe(false);
    });

    it("rejects an absolute write to another run's tree as out_of_prefix", async () => {
        const { tool } = buildTool();
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ path: `/${ANALYSIS}/runs/run-other/${STEP}/output/x.csv`, content: "evil" }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("out_of_prefix");
        expect(existsSync(join(sessionsBasePath, ANALYSIS, "runs", "run-other"))).toBe(false);
    });

    it("refuses a symlinked final component (symlink_denied) and keeps the target untouched", async () => {
        const { tool, workingDir } = buildTool();
        const { ctx } = makeToolContext();

        const outside = join(sessionsBasePath, "outside-target.txt");
        await writeFile(outside, "original");
        await mkdir(join(workingDir, "output"), { recursive: true });
        await symlink(outside, join(workingDir, "output", "link.txt"));

        const out = (await tool.execute({ path: "output/link.txt", content: "evil" }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("symlink_denied");
        expect(await readFile(outside, "utf8")).toBe("original");
        // The symlink itself is untouched too — refused, not replaced.
        expect((await lstat(join(workingDir, "output", "link.txt"))).isSymbolicLink()).toBe(true);
    });

    it("refuses a symlinked ancestor that escapes the prefix (out_of_prefix) and lands nothing outside", async () => {
        const { tool, workingDir } = buildTool();
        const { ctx } = makeToolContext();

        const outsideDir = join(sessionsBasePath, "outside-dir");
        await mkdir(outsideDir, { recursive: true });
        await mkdir(workingDir, { recursive: true });
        await symlink(outsideDir, join(workingDir, "output"));

        const out = (await tool.execute({ path: "output/escape.txt", content: "evil" }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("out_of_prefix");
        expect(existsSync(join(outsideDir, "escape.txt"))).toBe(false);
    });

    it("refuses a dangling-symlink ancestor as symlink_denied", async () => {
        const { tool, workingDir } = buildTool();
        const { ctx } = makeToolContext();

        await mkdir(workingDir, { recursive: true });
        await symlink(join(sessionsBasePath, "nowhere"), join(workingDir, "output"));

        const out = (await tool.execute({ path: "output/x.txt", content: "evil" }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("symlink_denied");
    });

    it("write/read agreement also holds for multi-byte content via UTF-8 buffer round-trip", async () => {
        const { tool } = buildTool();
        const { ctx } = makeToolContext();
        const content = "α,β,γ\n1,2,3\n";
        await tool.execute({ path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/u.csv`, content }, ctx);
        const fs = createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => join(sessionsBasePath, id) });
        const readTool = createReadFileTool(fs);
        const read = (await readTool.execute({ path: `runs/${RUN}/${STEP}/output/u.csv` }, ctx))._unsafeUnwrap();
        expect(read.status).toBe("ok");
        if (read.status === "ok") expect(read.content).toBe(content);
    });

    it("the write runs inside a replay-cached step — a cached replay lands no second write", async () => {
        const workspaceRoot = join(sessionsBasePath, ANALYSIS);
        const workingDir = workingDirOf();
        const mutator = createWorkspaceMutator({ workspaceRoot, analysisId: ANALYSIS, workingDir });

        // A caching RunStep: the first call runs the body, a later call with the
        // same name returns the recorded value without re-running it.
        const cache = new Map<string, unknown>();
        let bodyRuns = 0;
        const cachingStep = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
            if (cache.has(name)) return cache.get(name) as T;
            bodyRuns++;
            const value = await fn();
            cache.set(name, value);
            return value;
        };

        const first = await mutator.writeFile({
            path: "output/replay.txt",
            content: "v1",
            toolName: "write_file",
            invocationId: "inv-1",
            runStep: cachingStep,
            session: makeToolContext().ctx.session,
        });
        expect(first.status).toBe("ok");
        expect(bodyRuns).toBe(1);

        // Overwrite the landed file out of band, then replay: the cached step
        // returns ok without touching the disk again.
        const hostPath = resolvePath(workingDir, "output", "replay.txt");
        await writeFile(hostPath, "changed-on-disk");
        const replayed = await mutator.writeFile({
            path: "output/replay.txt",
            content: "v1",
            toolName: "write_file",
            invocationId: "inv-1",
            runStep: cachingStep,
            session: makeToolContext().ctx.session,
        });
        expect(replayed.status).toBe("ok");
        expect(bodyRuns).toBe(1);
        expect(await readFile(hostPath, "utf8")).toBe("changed-on-disk");
    });
});
