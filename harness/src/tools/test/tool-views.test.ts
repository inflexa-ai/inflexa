import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { okAsync } from "neverthrow";

import { runLoop } from "../../loop/run-loop.js";
import type { AgentDefinition, EmitEvent } from "../../loop/types.js";
import { makeSession } from "../../providers/__fixtures__/session.js";
import { callTools, reply, scriptedModel, text, toolCall } from "../../testing.js";
import { stepWritePrefix } from "../../workspace/paths.js";
import type { WorkspaceFilesystem } from "../../workspace/filesystem.js";
import type { Tool } from "../define-tool.js";
import { createWorkspaceMutator } from "../workspace/mutator.js";
import { createReadFileTool } from "../workspace/read-file.js";
import { createWriteFileTool } from "../workspace/write-file.js";

const ANALYSIS = "analysis-001";

const fakeFs: WorkspaceFilesystem = {
    readFile: () => okAsync({ kind: "ok", content: Buffer.from("hello"), truncated: false }),
    readBytes() {
        throw new Error("not used");
    },
    list() {
        throw new Error("not used");
    },
    stat() {
        throw new Error("not used");
    },
};

describe("the views of the file tools", () => {
    let base: string;

    beforeEach(() => {
        base = mkdtempSync(join(tmpdir(), "tool-views-"));
    });
    afterEach(() => {
        rmSync(base, { recursive: true, force: true });
    });

    async function callOf(tool: Tool, input: unknown) {
        const model = scriptedModel([callTools(toolCall("c1", tool.id, input)), reply([text("done")])]);
        const agent: AgentDefinition = { id: "a", systemPrompt: "s", model: "m", tools: [tool], maxIterations: 3 };
        const events: EmitEvent[] = [];
        await runLoop(agent, [], makeSession(), {
            provider: model.provider,
            signal: new AbortController().signal,
            emit: (event) => {
                if (event.type === "tool-started" || event.type === "tool-finished") events.push(event);
            },
            turnInput: [{ role: "user", content: "go" }],
        });
        const finished = events.find((event) => event.type === "tool-finished");
        if (finished?.type !== "tool-finished") throw new Error("the loop emitted no tool-finished");
        return finished;
    }

    it("read_file gives an input and no result", async () => {
        const finished = await callOf(createReadFileTool(fakeFs), { path: "data/a.csv" });

        expect(finished.outcome).toBe("ok");
        expect(finished.input).toEqual({ kind: "json", text: '{"path":"data/a.csv"}', cut: false });
        expect(finished.result).toBeUndefined();
    });

    it("write_file gives an input and a result", async () => {
        const workspaceRoot = join(base, ANALYSIS);
        const workingDir = stepWritePrefix({ workspaceRoot, runId: "run-abc", stepId: "step-1" });
        const mutator = createWorkspaceMutator({ workspaceRoot, analysisId: ANALYSIS, workingDir });

        const finished = await callOf(createWriteFileTool({ mutator }), { path: "out/a.txt", content: "hello" });

        expect(finished.outcome).toBe("ok");
        expect(finished.input).toEqual({ kind: "json", text: '{"path":"out/a.txt","content":"hello"}', cut: false });
        expect(finished.result).toMatchObject({ kind: "json", cut: false });
        expect(finished.result?.kind === "json" ? finished.result.text : "").toContain('"status":"ok"');
    });
});
