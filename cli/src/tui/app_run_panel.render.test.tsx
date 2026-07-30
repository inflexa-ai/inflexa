import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { okAsync } from "neverthrow";
import { testRender } from "@opentui/solid";

import { freshDb } from "../test_support/db.ts";
import { str256 } from "../lib/types.ts";
import { createAnalysis } from "../modules/analysis/analysis.ts";
import { App } from "./app.tsx";
import { dialogClear } from "./components/dialog/dialog_host.tsx";
import { __setAgentModelsForTest, __setBootStateForTest } from "./hooks/boot.ts";
import { __resetNoticesForTest, currentNotice } from "./hooks/notice.ts";
import { __resetRunPanelForTest, focusedSubject, runPanelVisible, toggleRunPanel } from "./hooks/run_panel.ts";
import { __resetRunCompletionsForTest } from "./hooks/run_completion.ts";
import { __resetSidebarLiveForTest, refreshSidebarData, type RefreshSeams } from "./hooks/sidebar_live.ts";
import { resetHotState } from "./hooks/conversation.ts";
import { __resetThreadWriteLocksForTest } from "./hooks/thread_write.ts";
import type { Analysis } from "../types/analysis.ts";
import type { CortexRunRow, DataProfileStatus, StepExecutionRow } from "@inflexa-ai/harness";
import type { HarnessRuntime } from "../modules/harness/runtime.ts";

// Every piece of the run-observability work is unit-tested in isolation; what nothing covered is
// `App`'s own COMPOSITION — that it mounts the panel between the stream and the input, that it calls
// the two watchers under its reactive owner, and that the panel really contributes zero rows when
// there is nothing to show. Those are exactly the seams a passing unit suite cannot vouch for, and
// the panel's placement is load-bearing (it sits under a flexGrow scrollbox, where a row that does
// not paint its own background lets scrolled content bleed through).
//
// This drives the REAL `App` against the REAL stores, seeding run state through `refreshSidebarData`
// with fake ledger seams — the same door production uses.

const fakeRuntime = { pool: {} } as unknown as HarnessRuntime;

let dir = "";
let analysis: Analysis;

function runRow(over: Partial<CortexRunRow> & { runId: string }): CortexRunRow {
    return {
        analysisId: analysis.id,
        threadId: null,
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
        planId: "plan-1",
        ...over,
    };
}

function seamsFor(runs: CortexRunRow[]): RefreshSeams {
    return {
        runtime: () => fakeRuntime,
        loadProfile: () => okAsync<DataProfileStatus | null, never>(null),
        loadRuns: () => okAsync(runs),
        loadActiveRuns: () => okAsync(runs.filter((r) => r.status === "running")),
        loadSteps: (_pool, runId) =>
            okAsync([
                {
                    runId,
                    stepId: "T1S1",
                    analysisId: analysis.id,
                    wave: 0,
                    agentId: "bioinformatician",
                    status: "running",
                    startedAt: null,
                    completedAt: null,
                    attempts: 1,
                    blockedReason: null,
                },
            ] as StepExecutionRow[]),
        loadPlan: () => okAsync<unknown | null, never>({ title: "Differential expression", steps: [{ id: "T1S1", name: "align reads" }] }),
    };
}

beforeEach(() => {
    freshDb();
    dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-app-panel-")));
    analysis = createAnalysis({ cwd: dir, name: str256("panel-test")._unsafeUnwrap(), inputPaths: [] })._unsafeUnwrap();
    // `ready` is what opens the input gate and stops the boot indicator claiming rows of its own.
    __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
    __setAgentModelsForTest({ current: { conversation: "m", sandbox: "m" }, pending: new Map() });
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    dialogClear();
    resetHotState();
    __resetSidebarLiveForTest();
    __resetRunPanelForTest();
    __resetRunCompletionsForTest();
    __resetNoticesForTest();
    __resetThreadWriteLocksForTest();
    __setBootStateForTest({ phase: "idle" });
});

/**
 * Mount the real `App`, then hand back a `seed` + `frame` pair.
 *
 * Seeding must happen AFTER the mount, not before: `App` installs `watchSidebarData`, whose
 * ready-edge effect immediately refreshes with the PRODUCTION seams — and with no booted runtime
 * those reads clear every snapshot. Anything seeded beforehand is wiped by the app's own first
 * refresh, which is exactly the race that made the first draft of this file flaky.
 */
async function mountApp(size = { width: 100, height: 26 }) {
    // No sessionId prop: App binds its thread only at the boot-ready edge, and with no booted
    // runtime that bind no-ops — the scope stays unbound and the transcript stays empty, which is
    // the blank-chat baseline these frames assert against.
    const setup = await testRender(() => <App workingDir={dir} analysis={analysis} />, size);
    const settle = async (): Promise<string> => {
        for (let i = 0; i < 3; i++) {
            await new Promise((r) => setTimeout(r, 20));
            await setup.renderOnce();
        }
        return setup.captureCharFrame();
    };
    await settle();
    return {
        seed: (runs: CortexRunRow[]) => refreshSidebarData(analysis.id, seamsFor(runs)),
        frame: settle,
        destroy: () => setup.renderer.destroy(),
    };
}

describe("App composes the run-activity panel", () => {
    test("with an active run, the panel renders inside the chat column", async () => {
        const app = await mountApp();
        try {
            await app.seed([runRow({ runId: "run-a" })]);
            expect(runPanelVisible()).toBe(true);
            const frame = await app.frame();
            // The plan title is the panel's run label and the frontier step is its own line — both
            // reach the screen only through App's mount.
            expect(frame).toContain("Differential expression");
            expect(frame).toContain("align reads");
        } finally {
            app.destroy();
        }
    });

    test("the panel sits BELOW the stream's scroll region and ABOVE the composer", async () => {
        const app = await mountApp();
        try {
            await app.seed([runRow({ runId: "run-a" })]);
            const lines = (await app.frame()).split("\n");
            const panelRow = lines.findIndex((l) => l.includes("align reads"));
            const hintRow = lines.findIndex((l) => l.includes("hide"));
            // The composer's INSERT/NORMAL mode word rides the chat bar's chrome, so it marks the input.
            const composerRow = lines.findIndex((l) => l.includes("INSERT") || l.includes("NORMAL"));

            expect(panelRow).toBeGreaterThan(0);
            expect(composerRow).toBeGreaterThan(0);
            // Panel frontier, then its hint, then the composer — the documented column order.
            expect(hintRow).toBeGreaterThan(panelRow);
            expect(composerRow).toBeGreaterThan(hintRow);
        } finally {
            app.destroy();
        }
    });

    test("no active run → the panel contributes nothing to the frame", async () => {
        const app = await mountApp();
        try {
            await app.seed([runRow({ runId: "run-a", status: "completed", completedAt: "2026-07-28T10:01:00.000Z" })]);
            expect(runPanelVisible()).toBe(false);
            const frame = await app.frame();
            expect(frame).not.toContain("align reads");
            // The panel's own hint line — a string that exists only when it renders — is absent too.
            expect(frame).not.toContain("hide");
        } finally {
            app.destroy();
        }
    });

    test("dismissing removes the panel's rows but leaves the run on every other surface", async () => {
        const app = await mountApp();
        try {
            await app.seed([runRow({ runId: "run-a" })]);
            expect((await app.frame()).includes("hide")).toBe(true);

            toggleRunPanel();
            const frame = await app.frame();

            // The panel's hint line is the string only IT renders, so its absence is the panel's.
            expect(frame).not.toContain("hide");
            // The sidebar keeps showing the run — dismissal is view state for one surface, never a
            // withdrawal of the run from the app. Asserted on the rail's own rows, which is why this
            // cannot just check for the step name: both surfaces render it.
            const railRows = frame.split("\n").filter((l) => l.includes("│"));
            expect(railRows.some((l) => l.includes("align reads"))).toBe(true);
            expect(railRows.some((l) => l.includes("Differential expression"))).toBe(true);
            // And the run is still tracked and focused underneath. Focus is a subject union, so naming
            // the run id also asserts the focused subject is that RUN rather than another kind.
            const subject = focusedSubject();
            expect(subject?.kind === "run" ? subject.run.runId : null).toBe("run-a");
        } finally {
            app.destroy();
        }
    });

    test("App wires the completion watcher: a run terminating under a mounted App announces", async () => {
        const app = await mountApp();
        try {
            // Observed running, then terminal — the edge the watcher reacts to. Driven while App is
            // mounted, so the effect `watchRunCompletions` installed is the one that fires.
            await app.seed([runRow({ runId: "run-a" })]);
            expect(currentNotice()).toBeNull();

            await app.seed([runRow({ runId: "run-a", status: "completed", completedAt: "2026-07-28T10:02:30.000Z" })]);
            for (let i = 0; i < 6; i++) await Promise.resolve();

            expect(currentNotice()).not.toBeNull();
            expect(currentNotice()!.text).toContain("completed");
        } finally {
            app.destroy();
        }
    });
});
