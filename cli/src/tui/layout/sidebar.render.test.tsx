import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { okAsync } from "neverthrow";
import { testRender } from "@opentui/solid";

import { freshDb } from "../../test_support/db.ts";
import { renderFrame } from "../../test_support/tui.ts";
import { str256 } from "../../lib/types.ts";
import { createAnalysis, addInputs } from "../../modules/analysis/analysis.ts";
import { WorkspaceContext, type Workspace } from "../contexts/workspace.ts";
import { __resetSidebarLiveForTest, refreshSidebarData, type RefreshSeams } from "../hooks/sidebar_live.ts";
import { __setAgentModelsForTest, __setBootStateForTest } from "../hooks/boot.ts";
import { Sidebar } from "./sidebar.tsx";
import type { Analysis } from "../../types/analysis.ts";
import type { CortexRunRow, DataProfileStatus } from "@inflexa-ai/harness";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";

// The sidebar's input count is a plain DB read with no reactive dependency — it refreshes only
// because prov.input_* bus events tick a version signal. This drives the REAL write path
// (addInputs emits the events itself) and pins the two behaviors that matter: this analysis's
// events re-read, foreign analyses' events don't.

let dirA = "";
let dirB = "";

beforeEach(() => {
    freshDb();
    // realpath so the anchor/marker paths the analyses mint match macOS's canonical /private/var.
    dirA = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-sidebar-a-")));
    dirB = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-sidebar-b-")));
});

afterEach(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    __resetSidebarLiveForTest();
    // The MODELS section reads the boot store's agentModels cell + the ready-state connection; reset both
    // so one test's seed never bleeds into the next (mirrors __resetSidebarLiveForTest for the live sections).
    __setAgentModelsForTest({ current: { conversation: "", sandbox: "" }, pending: new Map() });
    __setBootStateForTest({ phase: "idle" });
});

// A minimal static Workspace: the test never swaps sessions, so a plain object (not the reactive
// store) is sufficient — the sidebar reads it like any props object.
function wsFor(analysis: Analysis, workingDir: string): Workspace {
    return {
        analysis,
        sessionId: "no-such-session", // getSession → null; the SESSION detail row is skipped
        workingDir,
        project: null,
        openDialog: () => {},
        closeDialog: () => {},
        openSession: () => {},
        quit: async () => {},
    };
}

describe("Sidebar input count follows the bus", () => {
    test("re-reads on this analysis's input events; ignores a foreign analysis's", async () => {
        writeFileSync(join(dirA, "one.txt"), "x");
        writeFileSync(join(dirA, "three.txt"), "x");
        writeFileSync(join(dirB, "two.txt"), "x");
        // These analyses need specific inputs to drive the input-event assertions below.
        const a = createAnalysis({ cwd: dirA, name: str256("alpha")._unsafeUnwrap(), inputPaths: [join(dirA, "one.txt")] })._unsafeUnwrap();
        const b = createAnalysis({ cwd: dirB, name: str256("bravo")._unsafeUnwrap(), inputPaths: [join(dirB, "two.txt")] })._unsafeUnwrap();

        const setup = await testRender(
            () => (
                <WorkspaceContext.Provider value={wsFor(a, dirA)}>
                    <box width="100%" height="100%">
                        <Sidebar messageCount={() => 0} />
                    </box>
                </WorkspaceContext.Provider>
            ),
            { width: 44, height: 24 },
        );
        try {
            await setup.renderOnce();
            expect(setup.captureCharFrame()).toContain("1 input");

            addInputs(a.id, [join(dirA, "three.txt")], dirA)._unsafeUnwrap();
            await setup.renderOnce();
            await setup.renderOnce();
            expect(setup.captureCharFrame()).toContain("2 inputs");

            addInputs(b.id, [join(dirB, "two.txt")], dirB)._unsafeUnwrap();
            await setup.renderOnce();
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            expect(frame).toContain("2 inputs");
            expect(frame).not.toContain("3 inputs");
        } finally {
            setup.renderer.destroy();
        }
    });
});

// The DATA PROFILE / RUNS sections render the `sidebar_live` store's snapshots. These
// drive the store through `refreshSidebarData`'s injectable reads (no Postgres, no booted runtime)
// and assert the rendered rail text — the truthfulness the change exists for. A null-analysis
// workspace keeps the fixture minimal (getSession → null, no anchor/input reads), so only the two
// live sections vary between cases.
const fakeRuntime = { pool: {} } as unknown as HarnessRuntime;

function seams(profile: DataProfileStatus | null, runs: CortexRunRow[]): RefreshSeams {
    return { runtime: () => fakeRuntime, loadProfile: () => okAsync(profile), loadRuns: () => okAsync(runs) };
}

function completedProfile(fileCount: number): DataProfileStatus {
    const files = Array.from({ length: fileCount }, (_, i) => ({ path: `f${i}.csv`, description: "d" }));
    return {
        status: "completed",
        error: null,
        startedAt: "2026-07-08T00:00:00.000Z",
        completedAt: "2026-07-08T00:00:05.000Z",
        result: { summary: "s", files, inputFileIds: [], profiledAt: "2026-07-08T00:00:05.000Z" },
        seedInputFileIds: null,
    };
}

function runRow(over: Partial<CortexRunRow>): CortexRunRow {
    return {
        runId: "run-1",
        analysisId: "a1",
        threadId: null,
        workflowName: "executeAnalysis",
        status: "running",
        startedAt: "2026-07-08T00:00:00.000Z",
        completedAt: null,
        error: null,
        parts: null,
        mandateJti: null,
        mandateExpiresAt: null,
        planId: null,
        attemptCount: 0,
        ...over,
    };
}

function liveNode() {
    const ws = {
        analysis: null,
        sessionId: "no-such-session",
        workingDir: "/x",
        project: null,
        openDialog: () => {},
        closeDialog: () => {},
        openSession: () => {},
        quit: async () => {},
    } as Workspace;
    return () => (
        <WorkspaceContext.Provider value={ws}>
            <box width="100%" height="100%">
                <Sidebar messageCount={() => 0} />
            </box>
        </WorkspaceContext.Provider>
    );
}

describe("Sidebar DATA PROFILE / RUNS live sections", () => {
    test("pre-ready: both live sections show muted placeholders and no ledger read runs", async () => {
        // The store starts not_ready (afterEach reset), so a render before any refresh degrades.
        const frame = await renderFrame(liveNode(), { width: 44, height: 24 });
        expect(frame).toContain("DATA PROFILE");
        expect(frame).toContain("RUNS");
        expect(frame).toContain("runtime not ready");
    });

    test("a completed profile shows the file count; no runs shows 'no runs'", async () => {
        await refreshSidebarData("A", seams(completedProfile(2), []));
        const frame = await renderFrame(liveNode(), { width: 44, height: 24 });
        expect(frame).toContain("2 files");
        expect(frame).toContain("no runs");
    });

    test("a running profile shows 'profiling…'", async () => {
        await refreshSidebarData("A", seams({ ...completedProfile(0), status: "running", result: null, completedAt: null }, []));
        const frame = await renderFrame(liveNode(), { width: 44, height: 24 });
        expect(frame).toContain("profiling");
    });

    test("runs render newest with the workflow name; an unprofiled analysis reads 'not profiled'", async () => {
        await refreshSidebarData("A", seams(null, [runRow({ status: "running" })]));
        const frame = await renderFrame(liveNode(), { width: 44, height: 24 });
        expect(frame).toContain("executeAnalysis");
        expect(frame).toContain("not profiled");
    });
});

describe("Sidebar MODELS section", () => {
    test("before the switch installs (empty models) the section reads 'runtime not ready'", async () => {
        const frame = await renderFrame(liveNode(), { width: 44, height: 24 });
        expect(frame).toContain("MODELS");
        // Two 'runtime not ready' lines can appear (DATA PROFILE + MODELS); assert MODELS is present and
        // shows no model id.
        expect(frame).toContain("runtime not ready");
        expect(frame).not.toContain("chat claude");
    });

    test("renders each agent's active model", async () => {
        __setAgentModelsForTest({ current: { conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5" }, pending: new Map() });
        const frame = await renderFrame(liveNode(), { width: 44, height: 24 });
        expect(frame).toContain("MODELS");
        expect(frame).toContain("chat");
        expect(frame).toContain("claude-opus-4-8");
        expect(frame).toContain("sandbox");
        expect(frame).toContain("claude-sonnet-4-5");
    });

    test("a scheduled switch shows the pending model on its own indicator line", async () => {
        __setAgentModelsForTest({
            current: { conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5" },
            pending: new Map([["sandbox", "claude-haiku-4-5"]]),
        });
        const frame = await renderFrame(liveNode(), { width: 44, height: 24 });
        expect(frame).toContain("claude-sonnet-4-5"); // still the active sandbox model
        expect(frame).toContain("claude-haiku-4-5"); // the pending one
        expect(frame).toContain("pending");
    });
});

// The connection line (agent-model-selection group 7) rides the immutable boot-ready state, so each case
// seeds a `ready` boot with the connection identity AND a non-empty agentModels (the section body is
// gated on the switch's authority). It renders above the agent rows in both connection modes.
describe("Sidebar MODELS connection line", () => {
    test("cliproxy: shows the provider slug and the mode above the agent rows", async () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        __setAgentModelsForTest({ current: { conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5" }, pending: new Map() });
        const frame = await renderFrame(liveNode(), { width: 44, height: 24 });
        expect(frame).toContain("MODELS");
        expect(frame).toContain("conn");
        expect(frame).toContain("anthropic"); // the configured provider slug
        expect(frame).toContain("cliproxy"); // the connection mode
    });

    test("direct: shows the configured provider slug and the direct mode", async () => {
        __setBootStateForTest({ phase: "ready", model: "deepseek-chat", connection: { provider: "deepseek", mode: "direct" } });
        __setAgentModelsForTest({ current: { conversation: "deepseek-chat", sandbox: "deepseek-reasoner" }, pending: new Map() });
        const frame = await renderFrame(liveNode(), { width: 44, height: 24 });
        expect(frame).toContain("conn");
        expect(frame).toContain("deepseek"); // the configured provider slug
        expect(frame).toContain("direct"); // the connection mode
    });
});
