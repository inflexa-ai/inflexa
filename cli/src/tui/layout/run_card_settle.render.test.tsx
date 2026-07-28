import { afterEach, describe, expect, test } from "bun:test";
import { okAsync, errAsync } from "neverthrow";

import { testRender } from "@opentui/solid";
import { renderFrame } from "../../test_support/tui.ts";
import { RunCardBlock } from "../components/run_card_block.tsx";
import { MessageBlock, resolveRunCardState } from "./message_block.tsx";
import { __resetSidebarLiveForTest, refreshSidebarData, type RefreshSeams } from "../hooks/sidebar_live.ts";
import { cortexToUiMessage, type CortexMsg } from "../hooks/conversation.ts";
import type { CortexRunRow, DataProfileStatus, StepExecutionRow } from "@inflexa-ai/harness";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Part } from "../../types/session.ts";

// A run card is the conversation's memory of a launch. It must never vanish on completion — that is
// the very defect this work removes — and it must never keep a live meter once the run is over,
// because a progress bar frozen mid-run reads in scroll-back as work still in flight forever.

const WIDE = { width: 80, height: 14 };
const RUN_ID = "11111111-2222-3333-4444-555555555555";

const fakeRuntime = { pool: {} } as unknown as HarnessRuntime;

/**
 * Poll frames until `needle` appears. `<markdown internalBlockMode="top-level">` parses
 * ASYNCHRONOUSLY, so a single `renderOnce` sees an empty body (the same reason
 * `message_block.test.tsx` polls).
 */
async function frameWith(node: Parameters<typeof testRender>[0], needle: string, timeoutMs = 2000): Promise<string> {
    const setup = await testRender(node, WIDE);
    try {
        const start = Date.now();
        for (;;) {
            await setup.renderOnce();
            const f = setup.captureCharFrame();
            if (f.includes(needle) || Date.now() - start > timeoutMs) return f;
            await new Promise((r) => setTimeout(r, 10));
        }
    } finally {
        setup.renderer.destroy();
    }
}

function runRow(over: Partial<CortexRunRow> & { runId: string }): CortexRunRow {
    return {
        analysisId: "analysis-1",
        threadId: "thread-1",
        workflowName: "executeAnalysis",
        status: "running",
        startedAt: "2026-07-28T10:00:00.000Z",
        completedAt: null,
        error: null,
        synthesisStatus: null,
        synthesisReason: null,
        parts: null,
        mandateJti: null,
        mandateExpiresAt: null,
        planId: null,
        ...over,
    };
}

function seamsFor(runs: CortexRunRow[], opts: { runsFail?: boolean } = {}): RefreshSeams {
    return {
        runtime: () => fakeRuntime,
        loadProfile: () => okAsync<DataProfileStatus | null, never>(null),
        loadRuns: () => (opts.runsFail ? errAsync({ type: "query_failed", cause: "boom" } as never) : okAsync(runs)),
        loadActiveRuns: () => (opts.runsFail ? errAsync({ type: "query_failed", cause: "boom" } as never) : okAsync(runs)),
        loadSteps: (_pool, runId) =>
            okAsync([
                {
                    runId,
                    stepId: "T1S1",
                    analysisId: "analysis-1",
                    wave: 0,
                    agentId: "a",
                    status: "completed",
                    startedAt: null,
                    completedAt: null,
                    attempts: 1,
                    blockedReason: null,
                },
                {
                    runId,
                    stepId: "T1S2",
                    analysisId: "analysis-1",
                    wave: 0,
                    agentId: "a",
                    status: "running",
                    startedAt: null,
                    completedAt: null,
                    attempts: 1,
                    blockedReason: null,
                },
            ] as StepExecutionRow[]),
        loadPlan: () => okAsync<unknown | null, never>(null),
    };
}

afterEach(() => __resetSidebarLiveForTest());

describe("run card states", () => {
    test("with no resolved state it renders the launch record, exactly as before", async () => {
        const frame = await renderFrame(() => <RunCardBlock runId={RUN_ID} title="Differential expression" stepCount={4} />, WIDE);
        expect(frame).toContain("Differential expression");
        expect(frame).toContain("4 steps");
        expect(frame).toContain(RUN_ID);
        expect(frame).not.toContain("unavailable");
    });

    test("a live run shows a progress meter and its counts", async () => {
        const frame = await renderFrame(
            () => <RunCardBlock runId={RUN_ID} title="Differential expression" stepCount={4} state={{ kind: "live", done: 1, total: 4 }} />,
            WIDE,
        );
        expect(frame).toContain("1/4");
    });

    test("a settled run's meter is GONE, replaced by a compact outcome line", async () => {
        const frame = await renderFrame(
            () => (
                <RunCardBlock
                    runId={RUN_ID}
                    title="Differential expression"
                    stepCount={4}
                    state={{ kind: "settled", status: "completed", durationMs: 150_000, error: null }}
                />
            ),
            WIDE,
        );
        // The card is still here — never hidden, never removed.
        expect(frame).toContain("Differential expression");
        expect(frame).toContain(RUN_ID);
        // The outcome, with its duration.
        expect(frame).toContain("completed");
        expect(frame).toContain("2m30s");
        // And NO live meter: a frozen bar is a false claim in scroll-back. `x/y` is the meter's
        // signature and must not survive settlement.
        expect(frame).not.toMatch(/\d+\/\d+/);
    });

    test("a failed run's card carries the reason", async () => {
        const frame = await renderFrame(
            () => (
                <RunCardBlock
                    runId={RUN_ID}
                    title="Differential expression"
                    stepCount={4}
                    state={{ kind: "settled", status: "failed", durationMs: 30_000, error: "step T1S2 blocked: no counts matrix" }}
                />
            ),
            WIDE,
        );
        expect(frame).toContain("failed");
        expect(frame).toContain("step T1S2 blocked: no counts matrix");
    });

    test("an unresolvable run shows its identity and says so, never a fabricated status", async () => {
        const frame = await renderFrame(
            () => <RunCardBlock runId={RUN_ID} title="Differential expression" stepCount={4} state={{ kind: "unavailable" }} />,
            WIDE,
        );
        expect(frame).toContain("Differential expression");
        expect(frame).toContain(RUN_ID);
        expect(frame).toContain("run unavailable");
        // No invented outcome.
        expect(frame).not.toContain("completed");
        expect(frame).not.toContain("failed");
    });

    test("counts are omitted rather than fabricated when a settled run's steps are unknown", async () => {
        const frame = await renderFrame(
            () => <RunCardBlock runId={RUN_ID} title="R" stepCount={4} state={{ kind: "settled", status: "completed", durationMs: null, error: null }} />,
            WIDE,
        );
        expect(frame).not.toContain("0/0");
    });
});

describe("resolveRunCardState", () => {
    test("an active run resolves live, from the runId the card already carries", async () => {
        await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: RUN_ID })]));
        const state = resolveRunCardState(RUN_ID);
        expect(state?.kind).toBe("live");
        expect(state).toMatchObject({ done: 1, total: 2 });
    });

    test("a terminal run resolves settled, with its duration and reason", async () => {
        await refreshSidebarData(
            "analysis-1",
            seamsFor([runRow({ runId: RUN_ID, status: "failed", completedAt: "2026-07-28T10:00:45.000Z", error: "sandbox died" })]),
        );
        const state = resolveRunCardState(RUN_ID);
        expect(state).toEqual({ kind: "settled", status: "failed", durationMs: 45_000, error: "sandbox died" });
    });

    test("a run outside the read window resolves to nothing — not-fetched is not not-found", async () => {
        await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "some-other-run" })]));
        // Rendering `unavailable` here would put a false negative on every historical card.
        expect(resolveRunCardState(RUN_ID)).toBeUndefined();
    });

    test("a failed runs read resolves to unavailable — a positive finding, not a guess", async () => {
        await refreshSidebarData("analysis-1", seamsFor([], { runsFail: true }));
        expect(resolveRunCardState(RUN_ID)).toEqual({ kind: "unavailable" });
    });
});

describe("synthetic record entries in the transcript", () => {
    function cortexMsg(role: CortexMsg["role"], text: string): CortexMsg {
        return { id: "1", role, parts: [{ type: "text", text }] } as CortexMsg;
    }

    test("a system-roled record maps to an event entry, not a user turn", () => {
        const ui = cortexToUiMessage(cortexMsg("system", 'Analysis run "DE" (run-a) completed after 2m30s.'), "s1");
        expect(ui.role).toBe("event");
    });

    test("recognition is structural: prose that reads like a user question is still an event", () => {
        // The harness re-roles off its own marker, never off the text — so a record whose wording
        // resembles ordinary user prose cannot be mistaken for the user speaking.
        const ui = cortexToUiMessage(cortexMsg("system", "did the run finish yet?"), "s1");
        expect(ui.role).toBe("event");
    });

    test("a genuine user message is unaffected", () => {
        expect(cortexToUiMessage(cortexMsg("user", "run the plan"), "s1").role).toBe("user");
        expect(cortexToUiMessage(cortexMsg("assistant", "on it"), "s1").role).toBe("assistant");
    });

    test("an event entry renders with NEITHER turn marker and no turn number", async () => {
        const part: Part = { id: "p1", sessionId: "s1", messageId: "m1", type: "text", text: "RUNOUTCOMEBODY", createdAt: 0 };
        const frame = await frameWith(
            () => <MessageBlock index={2} role="event" parts={[part]} streamPartId={() => null} streamText={() => ""} />,
            "RUNOUTCOMEBODY",
        );
        expect(frame).toContain("RUNOUTCOMEBODY");
        // Neither party's marker or label, and no `#N` — it is not a turn.
        expect(frame).not.toContain("You");
        expect(frame).not.toContain("Inflexa");
        expect(frame).not.toContain("#2");
    });

    test("a user turn still renders its marker exactly as before", async () => {
        const part: Part = { id: "p1", sessionId: "s1", messageId: "m1", type: "text", text: "USERBODY", createdAt: 0 };
        const frame = await frameWith(() => <MessageBlock index={1} role="user" parts={[part]} streamPartId={() => null} streamText={() => ""} />, "USERBODY");
        expect(frame).toContain("You");
        expect(frame).toContain("#1");
    });
});
