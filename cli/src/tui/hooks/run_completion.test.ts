import { afterEach, describe, expect, jest, test } from "bun:test";
import { createRoot } from "solid-js";
import { errAsync, okAsync, ResultAsync } from "neverthrow";

import type { DataProfileView, RunDetail, RunSummary } from "../../api/runs.ts";
import type { ClientError } from "../../client/api.ts";
import { __resetNoticesForTest, __pendingNoticeCountForTest, currentNotice, notify } from "./notice.ts";
import { __resetSidebarLiveForTest, refreshSidebarData, type RefreshOpts } from "./sidebar_live.ts";
import { __resetRunCompletionsForTest, completionNoticeText, watchRunCompletions, type RunCompletionOpts } from "./run_completion.ts";

function runRow(over: Partial<RunSummary> & { runId: string }): RunSummary {
    return {
        threadId: "thread-1",
        planId: null,
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
        plan: null,
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

/** A client error for a failed read of a run by its id. */
const READ_FAILED: ClientError = { type: "unreachable", reason: "connection_failed", baseUrl: "http://127.0.0.1:0", cause: "boom" };

/** The error of a read of a run that the server answers with a status. */
function httpError(status: number): ClientError {
    return { type: "http", status, body: { error: status === 404 ? "not_found" : "internal_error", message: "x" } };
}

/** The `(analysisId, runId)` pairs that a fake `loadRun` received, and the options that carry the fake. */
type FakeRunReads = { reads: [string, string][]; opts: RunCompletionOpts };

/** A `loadRun` that records each read and answers with `answer`. */
function fakeRunReads(answer: (analysisId: string, runId: string) => ResultAsync<RunDetail, ClientError>): FakeRunReads {
    const reads: [string, string][] = [];
    return {
        reads,
        opts: {
            loadRun: (analysisId, runId) => {
                reads.push([analysisId, runId]);
                return answer(analysisId, runId);
            },
        },
    };
}

/** The detail of a run that ended at `completedAt`. */
function endedDetail(runId: string, status: RunSummary["status"] = "completed"): ResultAsync<RunDetail, ClientError> {
    return okAsync(runDetail(runRow({ runId, status, completedAt: "2026-07-28T10:02:30.000Z" })));
}

/** A read that stays open until the test calls `release`. */
function openRead(): { result: ResultAsync<RunDetail, ClientError>; release: (detail: RunDetail) => void } {
    // The Promise executor below runs synchronously, so `resolveRead` is assigned before `openRead` returns.
    let resolveRead!: (detail: RunDetail) => void;
    const promise = new Promise<RunDetail>((resolve) => {
        resolveRead = resolve;
    });
    return { result: ResultAsync.fromSafePromise(promise), release: resolveRead };
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

    test("notices are shown in arrival order, and none is skipped", () => {
        // A fake clock, because a real sleep under load can cross zero or two windows and hide the order.
        jest.useFakeTimers();
        try {
            const WINDOW = 4000;
            notify({ kind: "info", text: "one" }, WINDOW, { queue: true });
            notify({ kind: "info", text: "two" }, WINDOW, { queue: true });
            notify({ kind: "info", text: "three" }, WINDOW, { queue: true });
            expect(currentNotice()?.text).toBe("one");
            expect(__pendingNoticeCountForTest()).toBe(2);

            jest.advanceTimersByTime(WINDOW - 1);
            expect(currentNotice()?.text).toBe("one");
            jest.advanceTimersByTime(1);
            expect(currentNotice()?.text).toBe("two");
            jest.advanceTimersByTime(WINDOW);
            expect(currentNotice()?.text).toBe("three");
            jest.advanceTimersByTime(WINDOW);
            expect(currentNotice()).toBeNull();
            expect(__pendingNoticeCountForTest()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
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

describe("a run that leaves the runs read", () => {
    /** The runs read of `analysis-1` that holds only newer runs, so it does not hold the observed run. */
    const newerRuns = (): RefreshOpts => optsFor([runRow({ runId: "run-newer" })]);

    test("a run that ends after newer runs fill the window announces, from a read by its id", async () => {
        await createRoot(async (dispose) => {
            const fake = fakeRunReads((_analysisId, runId) => endedDetail(runId));
            watchRunCompletions(fake.opts);
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", planTitle: "Differential expression" })]));

            await refreshSidebarData("analysis-1", newerRuns());
            await settle();

            expect(fake.reads).toEqual([["analysis-1", "run-a"]]);
            expect(currentNotice()).toEqual({ kind: "info", text: "Run Differential expression completed in 2m30s (0/1 steps)" });
            expect(__pendingNoticeCountForTest()).toBe(0);

            // The announced run is no longer observed, so a later runs read does not read it again.
            await refreshSidebarData("analysis-1", newerRuns());
            await settle();
            expect(fake.reads).toHaveLength(1);
            expect(__pendingNoticeCountForTest()).toBe(0);
            dispose();
        });
    });

    test("a terminal status other than completed announces in its own tone", async () => {
        await createRoot(async (dispose) => {
            const fake = fakeRunReads((_analysisId, runId) => endedDetail(runId, "canceled"));
            watchRunCompletions(fake.opts);
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
            await refreshSidebarData("analysis-1", newerRuns());
            await settle();

            expect(currentNotice()?.kind).toBe("error");
            expect(currentNotice()?.text).toContain("was canceled");
            dispose();
        });
    });

    test("a run that the read shows running raises no notice and is read again at the next runs read", async () => {
        await createRoot(async (dispose) => {
            let answer = (): ResultAsync<RunDetail, ClientError> => okAsync(runDetail(runRow({ runId: "run-a" })));
            const fake = fakeRunReads(() => answer());
            watchRunCompletions(fake.opts);
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));

            await refreshSidebarData("analysis-1", newerRuns());
            await settle();
            expect(fake.reads).toHaveLength(1);
            expect(currentNotice()).toBeNull();

            answer = () => endedDetail("run-a");
            await refreshSidebarData("analysis-1", newerRuns());
            await settle();
            expect(fake.reads).toHaveLength(2);
            expect(currentNotice()?.text).toContain("completed");
            dispose();
        });
    });

    test("a 404 drops the run with no notice, and no later runs read reads it", async () => {
        await createRoot(async (dispose) => {
            const fake = fakeRunReads(() => errAsync(httpError(404)));
            watchRunCompletions(fake.opts);
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));

            await refreshSidebarData("analysis-1", newerRuns());
            await settle();
            await refreshSidebarData("analysis-1", newerRuns());
            await settle();

            expect(fake.reads).toEqual([["analysis-1", "run-a"]]);
            expect(currentNotice()).toBeNull();
            dispose();
        });
    });

    test("a failed read raises no notice and keeps the run, whether the failure is a status other than 404 or a transport error", async () => {
        for (const failure of [httpError(500), READ_FAILED]) {
            __resetSidebarLiveForTest();
            __resetRunCompletionsForTest();
            __resetNoticesForTest();
            await createRoot(async (dispose) => {
                let answer = (): ResultAsync<RunDetail, ClientError> => errAsync(failure);
                const fake = fakeRunReads(() => answer());
                watchRunCompletions(fake.opts);
                await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));

                await refreshSidebarData("analysis-1", newerRuns());
                await settle();
                expect(currentNotice()).toBeNull();
                expect(fake.reads).toHaveLength(1);

                answer = () => endedDetail("run-a");
                await refreshSidebarData("analysis-1", newerRuns());
                await settle();
                expect(fake.reads).toHaveLength(2);
                expect(currentNotice()?.text).toContain("completed");
                dispose();
            });
        }
    });

    test("two runs reads that miss the run send one read while that read is open", async () => {
        await createRoot(async (dispose) => {
            const open = openRead();
            const fake = fakeRunReads(() => open.result);
            watchRunCompletions(fake.opts);
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));

            await refreshSidebarData("analysis-1", newerRuns());
            await refreshSidebarData("analysis-1", newerRuns());
            await settle();
            expect(fake.reads).toEqual([["analysis-1", "run-a"]]);

            open.release(runDetail(runRow({ runId: "run-a", status: "completed", completedAt: "2026-07-28T10:02:30.000Z" })));
            await settle();
            expect(currentNotice()?.text).toContain("completed");
            expect(__pendingNoticeCountForTest()).toBe(0);
            dispose();
        });
    });

    test("at most four reads are open, and a later runs read starts the reads that waited", async () => {
        await createRoot(async (dispose) => {
            const open = new Map<string, ReturnType<typeof openRead>>();
            const fake = fakeRunReads((_analysisId, runId) => {
                const read = openRead();
                open.set(runId, read);
                return read.result;
            });
            watchRunCompletions(fake.opts);
            const ids = ["run-1", "run-2", "run-3", "run-4", "run-5", "run-6"];
            await refreshSidebarData("analysis-1", optsFor(ids.map((runId) => runRow({ runId }))));

            await refreshSidebarData("analysis-1", newerRuns());
            await settle();
            expect(fake.reads.map(([, runId]) => runId)).toEqual(["run-1", "run-2", "run-3", "run-4"]);

            // A runs read while the four reads are open starts none.
            await refreshSidebarData("analysis-1", newerRuns());
            await settle();
            expect(fake.reads).toHaveLength(4);

            for (const runId of ids.slice(0, 4))
                // Every id in `ids.slice(0, 4)` was read above, and the fake `loadRun` stored its open read.
                open.get(runId)!.release(runDetail(runRow({ runId, status: "completed", completedAt: "2026-07-28T10:02:30.000Z" })));
            await settle();
            await refreshSidebarData("analysis-1", newerRuns());
            await settle();
            expect(fake.reads.map(([, runId]) => runId)).toEqual([...ids.slice(0, 4), "run-5", "run-6"]);
            dispose();
        });
    });

    test("a read that resolves after a swap raises no notice, and the run is read again when its analysis opens again", async () => {
        await createRoot(async (dispose) => {
            const open = openRead();
            let answer: () => ResultAsync<RunDetail, ClientError> = () => open.result;
            const fake = fakeRunReads(() => answer());
            watchRunCompletions(fake.opts);
            await refreshSidebarData("analysis-A", optsFor([runRow({ runId: "run-a" })]));
            await refreshSidebarData("analysis-A", optsFor([runRow({ runId: "run-newer" })]));
            expect(fake.reads).toEqual([["analysis-A", "run-a"]]);

            await refreshSidebarData("analysis-B", optsFor([]));
            open.release(runDetail(runRow({ runId: "run-a", status: "completed", completedAt: "2026-07-28T10:02:30.000Z" })));
            await settle();
            expect(currentNotice()).toBeNull();

            answer = () => endedDetail("run-a");
            await refreshSidebarData("analysis-A", optsFor([runRow({ runId: "run-newer" })]));
            await settle();
            expect(fake.reads).toEqual([
                ["analysis-A", "run-a"],
                ["analysis-A", "run-a"],
            ]);
            expect(currentNotice()?.text).toContain("completed");
            dispose();
        });
    });

    test("a runs read that showed the run terminal first leaves the late read without a second notice", async () => {
        await createRoot(async (dispose) => {
            const open = openRead();
            const fake = fakeRunReads((_analysisId, runId) => (runId === "run-a" ? open.result : okAsync(runDetail(runRow({ runId })))));
            watchRunCompletions(fake.opts);
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
            await refreshSidebarData("analysis-1", newerRuns());
            expect(fake.reads).toHaveLength(1);

            // The run shows up terminal in a runs read while the by-id read is open.
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", status: "completed", completedAt: "2026-07-28T10:02:30.000Z" })]));
            await settle();
            expect(currentNotice()?.text).toContain("completed");

            open.release(runDetail(runRow({ runId: "run-a", status: "completed", completedAt: "2026-07-28T10:02:30.000Z" })));
            await settle();
            expect(__pendingNoticeCountForTest()).toBe(0);
            dispose();
        });
    });

    test("a run of an analysis that is not open is not read until its analysis opens again", async () => {
        await createRoot(async (dispose) => {
            const fake = fakeRunReads((_analysisId, runId) => endedDetail(runId));
            watchRunCompletions(fake.opts);
            await refreshSidebarData("analysis-A", optsFor([runRow({ runId: "run-a" })]));

            await refreshSidebarData("analysis-B", optsFor([runRow({ runId: "run-b" })]));
            await settle();
            expect(fake.reads).toEqual([]);
            expect(currentNotice()).toBeNull();

            await refreshSidebarData("analysis-A", optsFor([runRow({ runId: "run-newer" })]));
            await settle();
            expect(fake.reads).toEqual([["analysis-A", "run-a"]]);
            expect(currentNotice()?.text).toContain("completed");
            dispose();
        });
    });

    test("waiting runs get a read in turn, not only the first four in the order of observation", async () => {
        await createRoot(async (dispose) => {
            const fake = fakeRunReads((_analysisId, runId) => (runId === "run-5" ? endedDetail(runId) : okAsync(runDetail(runRow({ runId })))));
            watchRunCompletions(fake.opts);
            const ids = ["run-1", "run-2", "run-3", "run-4", "run-5"];
            await refreshSidebarData("analysis-1", optsFor(ids.map((runId) => runRow({ runId }))));

            await refreshSidebarData("analysis-1", newerRuns());
            await settle();
            expect(fake.reads.map(([, runId]) => runId)).toEqual(["run-1", "run-2", "run-3", "run-4"]);
            expect(currentNotice()).toBeNull();

            await refreshSidebarData("analysis-1", newerRuns());
            await settle();
            expect(fake.reads.map(([, runId]) => runId)).toContain("run-5");
            expect(currentNotice()?.text).toContain("completed");
            expect(__pendingNoticeCountForTest()).toBe(0);
            dispose();
        });
    });

    test("a failed read also moves the run behind the waiting runs", async () => {
        await createRoot(async (dispose) => {
            const fake = fakeRunReads((_analysisId, runId) => (runId === "run-5" ? endedDetail(runId) : errAsync(httpError(500))));
            watchRunCompletions(fake.opts);
            const ids = ["run-1", "run-2", "run-3", "run-4", "run-5"];
            await refreshSidebarData("analysis-1", optsFor(ids.map((runId) => runRow({ runId }))));

            await refreshSidebarData("analysis-1", newerRuns());
            await settle();
            await refreshSidebarData("analysis-1", newerRuns());
            await settle();
            expect(fake.reads.map(([, runId]) => runId)).toContain("run-5");
            expect(currentNotice()?.text).toContain("completed");
            dispose();
        });
    });

    test("an announced run that a recovery showed running again is dropped by the read, and not read again", async () => {
        await createRoot(async (dispose) => {
            const fake = fakeRunReads((_analysisId, runId) => endedDetail(runId));
            watchRunCompletions(fake.opts);
            const ended = runRow({ runId: "run-a", status: "completed", completedAt: "2026-07-28T10:02:30.000Z" });
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
            await refreshSidebarData("analysis-1", optsFor([ended]));
            await settle();
            expect(currentNotice()?.text).toContain("completed");

            // A recovery moves the run back to running; the next runs reads do not hold it.
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
            await refreshSidebarData("analysis-1", newerRuns());
            await settle();
            expect(fake.reads).toEqual([["analysis-1", "run-a"]]);

            await refreshSidebarData("analysis-1", newerRuns());
            await refreshSidebarData("analysis-1", newerRuns());
            await settle();
            expect(fake.reads).toHaveLength(1);
            expect(__pendingNoticeCountForTest()).toBe(0);
            dispose();
        });
    });

    test("an announced run that a runs read shows terminal again is dropped, and not read again", async () => {
        await createRoot(async (dispose) => {
            const fake = fakeRunReads((_analysisId, runId) => endedDetail(runId));
            watchRunCompletions(fake.opts);
            const ended = runRow({ runId: "run-a", status: "completed", completedAt: "2026-07-28T10:02:30.000Z" });
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
            await refreshSidebarData("analysis-1", optsFor([ended]));
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
            await refreshSidebarData("analysis-1", optsFor([ended]));
            await settle();
            expect(__pendingNoticeCountForTest()).toBe(0);

            await refreshSidebarData("analysis-1", newerRuns());
            await refreshSidebarData("analysis-1", newerRuns());
            await settle();
            expect(fake.reads).toEqual([]);
            dispose();
        });
    });

    test("a run that this TUI never saw running is not read", async () => {
        await createRoot(async (dispose) => {
            const fake = fakeRunReads((_analysisId, runId) => endedDetail(runId));
            watchRunCompletions(fake.opts);
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-old", status: "completed", completedAt: "2026-07-28T10:05:00.000Z" })]));
            await refreshSidebarData("analysis-1", newerRuns());
            await settle();
            expect(fake.reads).toEqual([]);
            expect(currentNotice()).toBeNull();
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
