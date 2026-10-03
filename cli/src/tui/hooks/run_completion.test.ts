import { afterEach, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { okAsync } from "neverthrow";

import type { DataProfileView, RunDetail, RunSummary } from "../../api/runs.ts";
import { __resetNoticesForTest, __pendingNoticeCountForTest, currentNotice, notify } from "./notice.ts";
import { __resetSidebarLiveForTest, refreshSidebarData, type RefreshOpts } from "./sidebar_live.ts";
import { __resetRunCompletionsForTest, completionNoticeText, watchRunCompletions } from "./run_completion.ts";

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

/** The detail of an active run: one running step, so the progress entry carries a label and counts. */
function runDetail(run: RunSummary): RunDetail {
    return {
        ...run,
        steps: [
            {
                stepId: "T1S1",
                agentId: "bioinformatician",
                status: "running",
                startedAt: "2026-07-28T10:00:01.000Z",
                completedAt: null,
                durationMs: null,
                error: null,
                attempts: 1,
                blockedReason: null,
            },
        ],
        unattributedUsage: null,
    };
}

/** Refresh options whose reads all answer from `runs`, with no profile and a ready runtime. */
function optsFor(runs: RunSummary[]): RefreshOpts {
    return {
        ready: () => true,
        loadProfile: () => okAsync<DataProfileView, never>({ status: null }),
        loadRuns: () => okAsync(runs),
        loadActiveRuns: () => okAsync(runs),
        loadRun: (_analysisId, runId) => okAsync(runDetail(runs.find((run) => run.runId === runId) ?? runRow({ runId }))),
    };
}

/** Let queued microtasks (the notice promotion) settle. */
async function settle(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

afterEach(() => {
    __resetSidebarLiveForTest();
    __resetRunCompletionsForTest();
    __resetNoticesForTest();
});

// The notice channel offers two delivery disciplines; these pin the one run completions use. They
// pass `{ queue: true }` explicitly because that is what `announce` passes — a completion is
// UNSOLICITED, so it must never be destroyed by the next arrival. (The default replace discipline,
// and the interaction between the two, are covered in `notice.test.ts`.)
describe("notice queue — the unsolicited discipline run completions use", () => {
    test("a notice raised while another is showing is queued, not dropped", () => {
        notify({ kind: "info", text: "first" }, 4000, { queue: true });
        expect(currentNotice()?.text).toBe("first");
        notify({ kind: "info", text: "second" }, 4000, { queue: true });
        // The showing notice keeps its full window — cutting it short is the loss the queue prevents.
        expect(currentNotice()?.text).toBe("first");
        expect(__pendingNoticeCountForTest()).toBe(1);
    });

    test("notices are shown in arrival order, and none is skipped", async () => {
        // Short windows so the queue drains inside the test, but long enough that one sleep advances
        // exactly one step — a window shorter than the sleep would drain several and hide the order.
        const WINDOW = 40;
        notify({ kind: "info", text: "one" }, WINDOW, { queue: true });
        notify({ kind: "info", text: "two" }, WINDOW, { queue: true });
        notify({ kind: "info", text: "three" }, WINDOW, { queue: true });
        expect(currentNotice()?.text).toBe("one");
        expect(__pendingNoticeCountForTest()).toBe(2);

        await Bun.sleep(WINDOW + 15);
        expect(currentNotice()?.text).toBe("two");
        await Bun.sleep(WINDOW + 15);
        expect(currentNotice()?.text).toBe("three");
        await Bun.sleep(WINDOW + 15);
        expect(currentNotice()).toBeNull();
        expect(__pendingNoticeCountForTest()).toBe(0);
    });
});

describe("run completion announcement", () => {
    test("a run already terminal on the first snapshot is history, not news", async () => {
        await createRoot(async (dispose) => {
            watchRunCompletions();
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-old", status: "completed", completedAt: "2026-07-28T10:05:00.000Z" })]));
            await settle();
            expect(currentNotice()).toBeNull();
            dispose();
        });
    });

    test("an observed transition announces, with the label and the counts it knew while the run was live", async () => {
        await createRoot(async (dispose) => {
            watchRunCompletions();
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", planTitle: "Differential expression" })]));
            expect(currentNotice()).toBeNull();

            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", status: "completed", completedAt: "2026-07-28T10:02:30.000Z" })]));
            await settle();

            expect(currentNotice()?.kind).toBe("info");
            expect(currentNotice()?.text).toBe("Run Differential expression completed in 2m30s (0/1 steps)");
            dispose();
        });
    });

    test("a failed run announces in the error tone and carries its reason", async () => {
        await createRoot(async (dispose) => {
            watchRunCompletions();
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
            await refreshSidebarData(
                "analysis-1",
                optsFor([runRow({ runId: "run-a", status: "failed", completedAt: "2026-07-28T10:01:00.000Z", error: "step T1S1 blocked" })]),
            );
            await settle();

            expect(currentNotice()?.kind).toBe("error");
            expect(currentNotice()?.text).toContain("step T1S1 blocked");
            dispose();
        });
    });

    test("every terminal status announces — not only success", async () => {
        for (const [status, kind] of [
            ["completed", "info"],
            ["failed", "error"],
            ["canceled", "error"],
            ["partial", "warn"],
        ] as const) {
            __resetSidebarLiveForTest();
            __resetRunCompletionsForTest();
            __resetNoticesForTest();
            await createRoot(async (dispose) => {
                watchRunCompletions();
                await refreshSidebarData("analysis-1", optsFor([runRow({ runId: `run-${status}` })]));
                await refreshSidebarData("analysis-1", optsFor([runRow({ runId: `run-${status}`, status, completedAt: "2026-07-28T10:01:00.000Z" })]));
                await settle();
                expect(currentNotice()).not.toBeNull();
                expect(currentNotice()!.kind).toBe(kind);
                dispose();
            });
        }
    });

    test("two runs terminating within one display window both announce", async () => {
        await createRoot(async (dispose) => {
            watchRunCompletions();
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" }), runRow({ runId: "run-b" })]));
            await refreshSidebarData(
                "analysis-1",
                optsFor([
                    runRow({ runId: "run-a", status: "completed", completedAt: "2026-07-28T10:01:00.000Z" }),
                    runRow({ runId: "run-b", status: "completed", completedAt: "2026-07-28T10:01:00.000Z" }),
                ]),
            );
            await settle();

            // One showing, one queued — neither discarded. Under a replace-on-arrival channel the first
            // would have been destroyed.
            expect(currentNotice()).not.toBeNull();
            expect(__pendingNoticeCountForTest()).toBe(1);
            dispose();
        });
    });

    test("a re-delivered terminal state produces exactly one notice", async () => {
        await createRoot(async (dispose) => {
            watchRunCompletions();
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
            const terminal = [runRow({ runId: "run-a", status: "completed", completedAt: "2026-07-28T10:01:00.000Z" })];

            // A durable-runtime recovery shows the same terminal state again; the refresh runs again.
            await refreshSidebarData("analysis-1", optsFor(terminal));
            await refreshSidebarData("analysis-1", optsFor(terminal));
            await refreshSidebarData("analysis-1", optsFor(terminal));
            await settle();

            expect(currentNotice()).not.toBeNull();
            expect(__pendingNoticeCountForTest()).toBe(0); // exactly the one showing
            dispose();
        });
    });

    test("distinct runs are not conflated — each announces on its own transition", async () => {
        await createRoot(async (dispose) => {
            watchRunCompletions();
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" }), runRow({ runId: "run-b" })]));
            await refreshSidebarData(
                "analysis-1",
                optsFor([runRow({ runId: "run-a", status: "completed", completedAt: "2026-07-28T10:01:00.000Z" }), runRow({ runId: "run-b" })]),
            );
            await settle();
            expect(currentNotice()?.text).toContain("completed");
            expect(__pendingNoticeCountForTest()).toBe(0);

            await refreshSidebarData(
                "analysis-1",
                optsFor([
                    runRow({ runId: "run-a", status: "completed", completedAt: "2026-07-28T10:01:00.000Z" }),
                    runRow({ runId: "run-b", status: "failed", completedAt: "2026-07-28T10:03:00.000Z" }),
                ]),
            );
            await settle();
            // run-b's notice queues behind run-a's; run-a does not announce a second time.
            expect(__pendingNoticeCountForTest()).toBe(1);
            dispose();
        });
    });

    test("a run with no thread still announces", async () => {
        await createRoot(async (dispose) => {
            watchRunCompletions();
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", threadId: null })]));
            await refreshSidebarData(
                "analysis-1",
                optsFor([runRow({ runId: "run-a", threadId: null, status: "completed", completedAt: "2026-07-28T10:01:00.000Z" })]),
            );
            await settle();
            expect(currentNotice()).not.toBeNull();
            dispose();
        });
    });
});

describe("completion text", () => {
    const known = { label: "Differential expression", done: 3, total: 4 };

    test("a success names the run, its outcome, its counts, and its duration", () => {
        const run = runRow({ runId: "run-a", status: "completed", completedAt: "2026-07-28T10:02:30.000Z" });
        expect(completionNoticeText(run, known)).toBe("Run Differential expression completed in 2m30s (3/4 steps)");
    });

    test("a non-success carries its reason", () => {
        const run = runRow({ runId: "run-a", status: "failed", completedAt: "2026-07-28T10:00:30.000Z", error: "sandbox died" });
        expect(completionNoticeText(run, known)).toStartWith("Run Differential expression failed in ");
        expect(completionNoticeText(run, known)).toEndWith("(3/4 steps): sandbox died");
    });

    test("the toast does not name the run id — the label is the handle a reader recognizes", () => {
        const run = runRow({ runId: "run-a", status: "completed", completedAt: "2026-07-28T10:01:00.000Z" });
        expect(completionNoticeText(run, known)).not.toContain("run-a");
    });

    test("an unbounded failure message is clipped, and marked as clipped", () => {
        // `run.error` is `err.message` from the workflow — unbounded, and able to carry a step's full
        // stderr. The toast is one transient line.
        const run = runRow({ runId: "run-a", status: "failed", completedAt: "2026-07-28T10:01:00.000Z", error: "E".repeat(50_000) });
        const notice = completionNoticeText(run, known);
        expect(notice.length).toBeLessThan(400);
        expect(notice).toContain("(truncated)");
    });

    test("a short failure message is passed through whole, with no truncation marker", () => {
        const run = runRow({ runId: "run-a", status: "failed", completedAt: "2026-07-28T10:01:00.000Z", error: "sandbox died" });
        expect(completionNoticeText(run, known)).toContain("sandbox died");
        expect(completionNoticeText(run, known)).not.toContain("(truncated)");
    });

    test("a missing completion timestamp drops the duration rather than printing NaN", () => {
        const run = runRow({ runId: "run-a", status: "failed", completedAt: null });
        expect(completionNoticeText(run, known)).not.toContain("NaN");
    });
});
