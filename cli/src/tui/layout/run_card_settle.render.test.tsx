import { afterEach, describe, expect, test } from "bun:test";
import { okAsync, errAsync } from "neverthrow";

import { testRender } from "@opentui/solid";
import { renderFrame } from "../../test_support/tui.ts";
import { GLYPHS } from "../../lib/design_system.ts";
import { RunCardBlock } from "../components/run_card_block.tsx";
import { MessageBlock, resolveRunCardState } from "./message_block.tsx";
import { __resetSidebarLiveForTest, refreshSidebarData, type RefreshOpts } from "../hooks/sidebar_live.ts";
import { loadMessages, messages, promptHistory, resetHotState } from "../hooks/conversation.ts";
import type { ChatMessage } from "@inflexa-ai/harness/contracts/index.js";
import type { DataProfileView, RunDetail, RunSummary } from "../../api/runs.ts";
import type { ClientError } from "../../client/api.ts";
import type { Part } from "../../types/session.ts";

// A run card is the conversation's memory of a launch. It must never vanish on completion — that is
// the very defect this work removes — and it carries no progress meter at any point: live done/total
// is the sidebar rail's and the run-activity panel's to show, and a third reading of one run's
// progress is what makes all three read as instruments rather than one record and two live surfaces.

const WIDE = { width: 80, height: 14 };
const RUN_ID = "11111111-2222-3333-4444-555555555555";

/** A failed read of the server, as each refresh read reports it. */
const READ_FAILED: ClientError = { type: "http", status: 500, body: { error: "internal_error", message: "The server failed to handle the request." } };

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

function runRow(over: Partial<RunSummary> & { runId: string }): RunSummary {
    return {
        threadId: "thread-1",
        workflowName: "executeAnalysis",
        workflowId: over.runId,
        status: "running",
        startedAt: "2026-07-28T10:00:00.000Z",
        completedAt: null,
        error: null,
        ...over,
    };
}

/** The detail of an active run: one done step and one running step. */
function runDetail(runId: string): RunDetail {
    const step = (stepId: string, status: "completed" | "running"): RunDetail["steps"][number] => ({
        stepId,
        agentId: "a",
        status,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        error: null,
        attempts: 1,
        blockedReason: null,
    });
    return { ...runRow({ runId }), steps: [step("T1S1", "completed"), step("T1S2", "running")], unattributedUsage: null };
}

function optsFor(runs: RunSummary[], opts: { runsFail?: boolean } = {}): RefreshOpts {
    return {
        ready: () => true,
        loadProfile: () => okAsync<DataProfileView, never>({ status: null }),
        loadRuns: () => (opts.runsFail ? errAsync(READ_FAILED) : okAsync(runs)),
        loadActiveRuns: () => (opts.runsFail ? errAsync(READ_FAILED) : okAsync(runs)),
        loadRun: (_analysisId, runId) => okAsync(runDetail(runId)),
    };
}

afterEach(() => __resetSidebarLiveForTest());

describe("run card states", () => {
    test("with no resolved state it renders the launch record, and no meter", async () => {
        const frame = await renderFrame(() => <RunCardBlock runId={RUN_ID} title="Differential expression" stepCount={4} />, WIDE);
        expect(frame).toContain("Differential expression");
        expect(frame).toContain("4 steps");
        expect(frame).toContain(RUN_ID);
        expect(frame).not.toContain("unavailable");
        // This is also what an ACTIVE run's card renders — `resolveRunCardState` gives a running run
        // no state at all. `x/y` is the meter's signature; the card never emits one.
        expect(frame).not.toMatch(/\d+\/\d+/);
        expect(frame).not.toContain(GLYPHS.bar);
    });

    test("a settled run's card is the launch record plus a compact outcome line", async () => {
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
        // And still no meter — the settled line states counts in words, never as a bar.
        expect(frame).not.toMatch(/\d+\/\d+/);
        expect(frame).not.toContain(GLYPHS.bar);
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
    test("an active run resolves to no state — its progress belongs to the rail and the panel", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: RUN_ID })]));
        expect(resolveRunCardState(RUN_ID)).toBeUndefined();
    });

    test("a runs read that failed under an active run still does not call it unavailable", async () => {
        // The active-run map and the runs snapshot fail independently, so this pair is reachable: the
        // run is known to be live, and reporting it unresolvable would be a falsehood the card prints.
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: RUN_ID })]));
        await refreshSidebarData("analysis-1", optsFor([], { runsFail: true }));
        expect(resolveRunCardState(RUN_ID)).toBeUndefined();
    });

    test("a terminal run resolves settled, with its duration and reason", async () => {
        await refreshSidebarData(
            "analysis-1",
            optsFor([runRow({ runId: RUN_ID, status: "failed", completedAt: "2026-07-28T10:00:45.000Z", error: "sandbox died" })]),
        );
        const state = resolveRunCardState(RUN_ID);
        expect(state).toEqual({ kind: "settled", status: "failed", durationMs: 45_000, error: "sandbox died" });
    });

    test("a run outside the read window resolves to nothing — not-fetched is not not-found", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "some-other-run" })]));
        // Rendering `unavailable` here would put a false negative on every historical card.
        expect(resolveRunCardState(RUN_ID)).toBeUndefined();
    });

    test("a failed runs read resolves to unavailable — a positive finding, not a guess", async () => {
        await refreshSidebarData("analysis-1", optsFor([], { runsFail: true }));
        expect(resolveRunCardState(RUN_ID)).toEqual({ kind: "unavailable" });
    });
});

describe("synthetic record entries in the transcript", () => {
    function chatMessage(id: string, role: ChatMessage["role"], text: string): ChatMessage {
        return { id, role, parts: [{ type: "text", text }] };
    }

    afterEach(() => resetHotState());

    test("a replayed system record mounts as a system entry, and no party's turn", async () => {
        // The harness re-roles a record off its own marker, never off the text — so a record whose wording
        // resembles ordinary user prose ("did the run finish yet?") cannot be mistaken for the user speaking.
        // The store mounts the role that the harness gives, and a genuine message keeps its own role.
        const replayed = [
            chatMessage("u1", "user", "run the plan"),
            chatMessage("r1", "system", "did the run finish yet?"),
            chatMessage("a1", "assistant", "on it"),
        ];
        await loadMessages("analysis-1", "s1", {
            fetchMessages: () => okAsync({ messages: replayed, total: replayed.length, page: 0, perPage: replayed.length, hasMore: false }),
        });

        expect(messages.map((m) => m.role)).toEqual(["user", "system", "assistant"]);
        // Not a prompt of the user, thus the history recall never offers it.
        expect(promptHistory()).toEqual(["run the plan"]);
    });

    test("a system entry renders with NEITHER turn marker and no turn number", async () => {
        const part: Part = { type: "text", text: "RUNOUTCOMEBODY" };
        const frame = await frameWith(
            () => <MessageBlock index={2} role="system" parts={[part]} streamPartId={() => null} streamText={() => ""} />,
            "RUNOUTCOMEBODY",
        );
        expect(frame).toContain("RUNOUTCOMEBODY");
        // Neither party's marker or label, and no `#N` — it is not a turn.
        expect(frame).not.toContain("You");
        expect(frame).not.toContain("Inflexa");
        expect(frame).not.toContain("#2");
    });

    test("a user turn still renders its marker exactly as before", async () => {
        const part: Part = { type: "text", text: "USERBODY" };
        const frame = await frameWith(() => <MessageBlock index={1} role="user" parts={[part]} streamPartId={() => null} streamText={() => ""} />, "USERBODY");
        expect(frame).toContain("You");
        expect(frame).toContain("#1");
    });
});
