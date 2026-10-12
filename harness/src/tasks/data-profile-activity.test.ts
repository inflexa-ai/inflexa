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
const ENTRY_ID = "activity-entry-data-profile-profile";

type Recorded = { type: string; id: string; runId: string; stepId: string; phase: string; activity: string; at?: string };

const CLOCK_START = Date.parse("2026-10-12T10:00:00.000Z");

/** A checkpointed clock stand-in: each read gives one second more than the read before. */
function stepClock(): () => Promise<number> {
    let reads = 0;
    return async () => CLOCK_START + 1000 * reads++;
}

/** Collect what a profile would have reported, in order, without a durability engine. */
function recorder(): { parts: Recorded[]; emitter: ProfileActivityEmitter } {
    const parts: Recorded[] = [];
    const emitter = createProfileActivityEmitter(
        async (part) => {
            parts.push(part as Recorded);
        },
        FRAME,
        createNoopLogger(),
        stepClock(),
    );
    return { parts, emitter };
}

/** The activity parts of a recording, without the history entries that follow each of them. */
const activityParts = (parts: Recorded[]): Recorded[] => parts.filter((p) => p.type === "data-step-activity");
const entryParts = (parts: Recorded[]): Recorded[] => parts.filter((p) => p.type === "data-activity-entry");

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

        expect(activityParts(parts).map((p) => [p.phase, p.activity])).toEqual([
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

        for (const part of activityParts(parts)) {
            expect(part.id).toBe(ACTIVITY_ID);
            expect(part.runId).toBe(FRAME.runId);
            expect(part.stepId).toBe(FRAME.stepId);
        }
        // One id across every phase is what lets the run-stream fold collapse them latest-wins onto a
        // single frame instead of accumulating one entry per transition.
        expect(new Set(activityParts(parts).map((p) => p.id)).size).toBe(1);
    });

    it("carries the failure reason verbatim, so the ledger and the stream agree", async () => {
        const { parts, emitter } = recorder();

        await emitter.failed("Data profiling failed: agent did not call submit_profile");

        expect(parts).toHaveLength(2);
        expect(parts[0]!.phase).toBe("failed");
        expect(parts[0]!.activity).toBe("Data profiling failed: agent did not call submit_profile");
        expect(parts[1]!.activity).toBe("Data profiling failed: agent did not call submit_profile");
    });
});

describe("profile activity emitter — tool phrases come from the called tool's own hook", () => {
    it("names the script an execute_command is running", async () => {
        const { parts, emitter } = recorder();

        await emitter.forTool("execute_command", { command: ["python3", "/analysis/runs/data-profile/profile/scripts/profile.py"] }, resolveDetail);

        expect(activityParts(parts)[0]!.activity).toBe("execute_command /analysis/runs/data-profile/profile/scripts/profile.py");
    });

    it("names the file a path-bearing tool is touching", async () => {
        const { parts, emitter } = recorder();

        await emitter.forTool("read_file", { path: "/analysis/data/inputs/f1/counts.csv" }, resolveDetail);
        await emitter.forTool("write_file", { path: "scripts/profile.py", content: "" }, resolveDetail);

        expect(activityParts(parts).map((p) => p.activity)).toEqual(["read_file /analysis/data/inputs/f1/counts.csv", "write_file scripts/profile.py"]);
    });

    it("names the tool when nothing can describe the call", async () => {
        const { parts, emitter } = recorder();

        // A hookless tool, and a tool absent from the supplied list.
        await emitter.forTool("submit_profile", {}, resolveDetail);
        await emitter.forTool("list_available_packages", {}, resolveDetail);
        // No resolver at all — the shape a caller that wires none gets.
        await emitter.forTool("read_file", { path: "a.csv" });

        expect(activityParts(parts).map((p) => p.activity)).toEqual(["submit_profile", "list_available_packages", "read_file"]);
    });
});

describe("profile activity emitter — a failed write never fails the profile", () => {
    it("resolves and reports the failure through the logger", async () => {
        const { warnings, logger } = warnRecorder();
        const emitter = createProfileActivityEmitter(() => Promise.reject(new Error("stream unavailable")), FRAME, logger, stepClock());

        // Resolving rather than rejecting IS the contract: observation is a diagnostic channel, and a
        // dropped frame must not fail a profile that is otherwise succeeding.
        await emitter.sandboxInit();
        await emitter.complete();

        // The activity write and the entry write of one emission fail alone, thus each logs.
        expect(warnings).toHaveLength(4);
        expect(warnings.map((w) => w.fields?.phase)).toEqual(["sandbox-init", "sandbox-init", "complete", "complete"]);
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
            stepClock(),
        );

        await emitter.sandboxInit();
        await emitter.agentStarting();

        // The first write of the first emission failed, and its entry and the whole second emission remain.
        expect(parts).toHaveLength(3);
    });

    it("keeps the entry of an emission whose activity write failed, and the next id in sequence", async () => {
        const parts: Recorded[] = [];
        let rejectActivity = true;
        const emitter = createProfileActivityEmitter(
            async (part) => {
                // The emitter writes only the parts that `activityEmission` builds, and each of them has the fields of `Recorded`.
                const recorded = part as Recorded;
                if (rejectActivity && recorded.type === "data-step-activity") {
                    rejectActivity = false;
                    throw new Error("transient");
                }
                parts.push(recorded);
            },
            FRAME,
            createNoopLogger(),
            stepClock(),
        );

        await emitter.sandboxInit();
        await emitter.complete();

        expect(entryParts(parts).map((p) => p.id)).toEqual([`${ENTRY_ID}-0`, `${ENTRY_ID}-1`]);
    });

    it("keeps the sequence when an entry write fails, and keeps reporting", async () => {
        const parts: Recorded[] = [];
        let rejectEntry = true;
        const emitter = createProfileActivityEmitter(
            async (part) => {
                // The emitter writes only the parts that `activityEmission` builds, and each of them has the fields of `Recorded`.
                const recorded = part as Recorded;
                if (rejectEntry && recorded.type === "data-activity-entry") {
                    rejectEntry = false;
                    throw new Error("transient");
                }
                parts.push(recorded);
            },
            FRAME,
            createNoopLogger(),
            stepClock(),
        );

        await emitter.sandboxInit();
        await emitter.complete();

        expect(activityParts(parts).map((p) => p.phase)).toEqual(["sandbox-init", "complete"]);
        expect(entryParts(parts).map((p) => p.id)).toEqual([`${ENTRY_ID}-1`]);
    });
});

describe("profile activity emitter — the time and the history", () => {
    it("gives each activity part its time from the injected clock", async () => {
        const { parts, emitter } = recorder();

        await emitter.sandboxInit();
        await emitter.complete();

        expect(activityParts(parts)).toEqual([
            {
                type: "data-step-activity",
                id: ACTIVITY_ID,
                runId: FRAME.runId,
                stepId: FRAME.stepId,
                phase: "sandbox-init",
                activity: "Starting sandbox",
                at: "2026-10-12T10:00:00.000Z",
            },
            {
                type: "data-step-activity",
                id: ACTIVITY_ID,
                runId: FRAME.runId,
                stepId: FRAME.stepId,
                phase: "complete",
                activity: "Profile complete",
                at: "2026-10-12T10:00:01.000Z",
            },
        ]);
    });

    it("writes one entry after each activity part, with the same phase, activity, and time", async () => {
        const { parts, emitter } = recorder();

        await emitter.sandboxInit();
        await emitter.scanning();
        await emitter.complete();

        expect(parts.map((p) => p.type)).toEqual([
            "data-step-activity",
            "data-activity-entry",
            "data-step-activity",
            "data-activity-entry",
            "data-step-activity",
            "data-activity-entry",
        ]);
        expect(entryParts(parts)).toEqual(activityParts(parts).map((p, i) => ({ ...p, type: "data-activity-entry", id: `${ENTRY_ID}-${i}` })));
    });

    it("gives unique ids to the entries, in sequence", async () => {
        const { parts, emitter } = recorder();

        await emitter.sandboxInit();
        await emitter.agentStarting();
        await emitter.indexing();

        expect(entryParts(parts).map((p) => p.id)).toEqual([`${ENTRY_ID}-0`, `${ENTRY_ID}-1`, `${ENTRY_ID}-2`]);
    });

    it("gives equal parts and ids to two emitters on the same clock sequence", async () => {
        const first = recorder();
        const second = recorder();

        for (const { emitter } of [first, second]) {
            await emitter.sandboxInit();
            await emitter.forTool("read_file", { path: "a.csv" });
            await emitter.complete();
        }

        expect(second.parts).toEqual(first.parts);
    });
});
