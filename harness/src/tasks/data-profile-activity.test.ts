import { describe, expect, it } from "bun:test";
import { ok } from "neverthrow";
import { z } from "zod";

import { createNoopLogger } from "../lib/console-logger.js";
import type { LogFields, Logger } from "../lib/logger.js";
import { defineTool } from "../tools/define-tool.js";
import { createDetailResolver } from "../tools/detail-resolver.js";
import { createExecuteCommandTool } from "../tools/workspace/execute-command.js";
import { createReadFileTool } from "../tools/workspace/read-file.js";
import { createWriteFileTool } from "../tools/workspace/write-file.js";
import { createProfileActivityEmitter, type ProfileActivityEmitter } from "./data-profile-activity.js";

// The data-profile workflow body is not reachable from a unit test — it needs a launched durability
// engine, a sandbox, a scripted model, and an embedder. The phase-and-phrase decisions are therefore
// lifted into the emitter and pinned here, which is where the observable contract of profile
// observability actually lives: these strings are what a user reads while waiting on a profile.
//
// What is NOT covered here, because it is body control flow rather than a decision: where each call
// sits relative to sandbox creation and the terminal ledger write. Those are guaranteed structurally
// in `data-profile.ts` (one `complete` call site, last statement of the success path) and confirmed
// by the operator against a live profile.

const FRAME = { runId: "data-profile", stepId: "profile" } as const;

/**
 * A resolver over the profiler's real tools, plus its hookless `submit_profile`.
 * The workflow body builds the same thing from `agentDef.tools`; the phrases a
 * user reads come from the tools themselves, not from a table here.
 */
const resolveDetail = createDetailResolver([
    createExecuteCommandTool({
        sandboxClient: {} as never,
        sandbox: {} as never,
        workflowId: "wf-1",
        stepId: "profile",
        nextFunctionId: () => "1",
        deadlineMs: () => 0,
        defaultCwd: "/analysis/runs/data-profile/profile",
    }),
    createReadFileTool({} as never, "/analysis/runs/data-profile/profile"),
    createWriteFileTool({ mutator: {} as never }),
    defineTool({
        id: "submit_profile",
        description: "Submit the profiling results. Declares no hook.",
        inputSchema: z.object({}),
        describeCall: "none",
        execute: async () => ok({ status: "accepted" }),
    }),
]);

/** The reconciling id every emission shares — the shared per-step construction over the frame above. */
const ACTIVITY_ID = "step-activity-data-profile-profile";

type Recorded = { type: string; id: string; runId: string; stepId: string; phase: string; activity: string };

/** Collect what a profile would have reported, in order, without a durability engine. */
function recorder(): { parts: Recorded[]; emitter: ProfileActivityEmitter } {
    const parts: Recorded[] = [];
    const emitter = createProfileActivityEmitter(
        async (part) => {
            parts.push(part as Recorded);
        },
        FRAME,
        createNoopLogger(),
    );
    return { parts, emitter };
}

/** A logger that records its warnings, so the swallow can be asserted as an observable outcome. */
function warnRecorder(): { warnings: { msg: string; fields?: LogFields }[]; logger: Logger } {
    const warnings: { msg: string; fields?: LogFields }[] = [];
    const base = createNoopLogger();
    const logger: Logger = {
        ...base,
        debug: () => {},
        info: () => {},
        error: () => {},
        warn: (msg, fields) => {
            warnings.push({ msg, fields });
        },
        with: () => logger,
        named: () => logger,
        errorFields: (err: unknown) => base.errorFields(err),
    };
    return { warnings, logger };
}

describe("profile activity emitter — the phases and their phrases", () => {
    it("reports the whole success lifecycle in order, with the specified phrases", async () => {
        const { parts, emitter } = recorder();

        await emitter.sandboxInit();
        await emitter.scanning();
        await emitter.agentStarting();
        await emitter.forTool("execute_command", { command: ["Rscript", "profile.R"] }, resolveDetail);
        await emitter.indexing();
        await emitter.complete();

        expect(parts.map((p) => [p.phase, p.activity])).toEqual([
            ["sandbox-init", "Starting sandbox"],
            // The deterministic scan sits between a ready sandbox and the agent's first turn.
            // Unreported it would read as `Running data-profiler` for minutes before the agent began.
            ["executing", "Scanning input files"],
            ["executing", "Running data-profiler"],
            ["executing", "execute_command profile.R"],
            ["indexing", "Indexing input descriptions for search"],
            ["complete", "Profile complete"],
        ]);
    });

    it("carries the workflow's synthetic frame and one reconciling id on every part", async () => {
        const { parts, emitter } = recorder();

        await emitter.sandboxInit();
        await emitter.indexing();
        await emitter.complete();

        for (const part of parts) {
            expect(part.type).toBe("data-step-activity");
            expect(part.id).toBe(ACTIVITY_ID);
            expect(part.runId).toBe(FRAME.runId);
            expect(part.stepId).toBe(FRAME.stepId);
        }
        // One id across every phase is what lets the run-stream fold collapse them latest-wins onto a
        // single frame instead of accumulating one entry per transition.
        expect(new Set(parts.map((p) => p.id)).size).toBe(1);
    });

    it("carries the failure reason verbatim, so the ledger and the stream agree", async () => {
        const { parts, emitter } = recorder();

        await emitter.failed("Data profiling failed: agent did not call submit_profile");

        expect(parts).toHaveLength(1);
        expect(parts[0]!.phase).toBe("failed");
        expect(parts[0]!.activity).toBe("Data profiling failed: agent did not call submit_profile");
    });
});

describe("profile activity emitter — tool phrases come from the called tool's own hook", () => {
    it("names the script an execute_command is running", async () => {
        const { parts, emitter } = recorder();

        await emitter.forTool("execute_command", { command: ["python3", "/analysis/runs/data-profile/profile/scripts/profile.py"] }, resolveDetail);

        expect(parts[0]!.activity).toBe("execute_command /analysis/runs/data-profile/profile/scripts/profile.py");
    });

    it("names the file a path-bearing tool is touching", async () => {
        const { parts, emitter } = recorder();

        await emitter.forTool("read_file", { path: "/analysis/data/inputs/f1/counts.csv" }, resolveDetail);
        await emitter.forTool("write_file", { path: "scripts/profile.py", content: "" }, resolveDetail);

        expect(parts.map((p) => p.activity)).toEqual(["read_file /analysis/data/inputs/f1/counts.csv", "write_file scripts/profile.py"]);
    });

    it("names the tool when nothing can describe the call", async () => {
        const { parts, emitter } = recorder();

        // A hookless tool, and a tool absent from the supplied list.
        await emitter.forTool("submit_profile", {}, resolveDetail);
        await emitter.forTool("list_available_packages", {}, resolveDetail);
        // No resolver at all — the shape a caller that wires none gets.
        await emitter.forTool("read_file", { path: "a.csv" });

        expect(parts.map((p) => p.activity)).toEqual(["submit_profile", "list_available_packages", "read_file"]);
    });
});

describe("profile activity emitter — a failed write never fails the profile", () => {
    it("resolves and reports the failure through the logger", async () => {
        const { warnings, logger } = warnRecorder();
        const emitter = createProfileActivityEmitter(() => Promise.reject(new Error("stream unavailable")), FRAME, logger);

        // Resolving rather than rejecting IS the contract: observation is a diagnostic channel, and a
        // dropped frame must not fail a profile that is otherwise succeeding.
        await emitter.sandboxInit();
        await emitter.complete();

        expect(warnings).toHaveLength(2);
        expect(warnings[0]!.fields?.phase).toBe("sandbox-init");
        expect(warnings[1]!.fields?.phase).toBe("complete");
    });

    it("keeps reporting after a write fails, rather than latching off", async () => {
        const parts: unknown[] = [];
        let firstCall = true;
        const emitter = createProfileActivityEmitter(
            async (part) => {
                if (firstCall) {
                    firstCall = false;
                    throw new Error("transient");
                }
                parts.push(part);
            },
            FRAME,
            createNoopLogger(),
        );

        await emitter.sandboxInit();
        await emitter.agentStarting();

        expect(parts).toHaveLength(1);
    });
});
