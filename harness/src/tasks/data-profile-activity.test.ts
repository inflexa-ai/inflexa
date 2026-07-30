import { describe, expect, it } from "bun:test";

import { createNoopLogger } from "../lib/console-logger.js";
import type { LogFields, Logger } from "../lib/logger.js";
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
        await emitter.agentStarting();
        await emitter.forTool("execute_command", { command: ["Rscript", "profile.R"] });
        await emitter.indexing();
        await emitter.complete();

        expect(parts.map((p) => [p.phase, p.activity])).toEqual([
            ["sandbox-init", "Starting sandbox"],
            ["executing", "Running data-profiler"],
            ["executing", "Running script profile.R"],
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

describe("profile activity emitter — tool phrases come from the shared translator", () => {
    it("names the script an execute_command is running", async () => {
        const { parts, emitter } = recorder();

        await emitter.forTool("execute_command", { command: ["python3", "/analysis/runs/data-profile/profile/scripts/profile.py"] });

        expect(parts[0]!.activity).toBe("Running script profile.py");
    });

    it("names the file a path-bearing tool is touching", async () => {
        const { parts, emitter } = recorder();

        await emitter.forTool("read_file", { path: "/analysis/data/inputs/f1/counts.csv" });
        await emitter.forTool("write_file", { path: "scripts/profile.py" });

        expect(parts.map((p) => p.activity)).toEqual(["Reading file counts.csv", "Writing file profile.py"]);
    });

    it("falls back to the bare tool name when the input carries no usable name", async () => {
        const { parts, emitter } = recorder();

        await emitter.forTool("execute_command", { command: ["ls", "-la"] });
        await emitter.forTool("submit_profile", {});

        expect(parts.map((p) => p.activity)).toEqual(["Running script", "Running submit_profile"]);
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
