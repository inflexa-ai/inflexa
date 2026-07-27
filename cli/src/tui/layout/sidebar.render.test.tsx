import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errAsync, okAsync } from "neverthrow";
import { testRender } from "@opentui/solid";
import { parseColor, rgbToHex, type RGBA } from "@opentui/core";

import { freshDb } from "../../test_support/db.ts";
import { renderFrame } from "../../test_support/tui.ts";
import { str256 } from "../../lib/types.ts";
import { DEFAULT_THEME_ID, GLYPHS, themes } from "../../lib/design_system.ts";
import { createAnalysis, addInputs } from "../../modules/analysis/analysis.ts";
import { getAnchor } from "../../db/primary_query.ts";
import { setTheme } from "../theme.ts";
import { WorkspaceContext, type Workspace } from "../contexts/workspace.ts";
import { __resetSidebarLiveForTest, absTime, absTimeShort, idTail, refreshSidebarData, relAge, type RefreshSeams } from "../hooks/sidebar_live.ts";
import { __resetOpenThreadForTest, refreshOpenThread, type ThreadSeams } from "../hooks/thread.ts";
import { __setAgentModelsForTest, __setBootStateForTest } from "../hooks/boot.ts";
import { Sidebar } from "./sidebar.tsx";
import type { Analysis } from "../../types/analysis.ts";
import type { CortexRunRow, DataProfileStatus, DbError, StepExecutionRow, Thread } from "@inflexa-ai/harness";
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
    // The SESSION section reads the open-thread snapshot (another module singleton) and the loaded-state
    // case repaints on a light theme; drop both so one case's seed never bleeds into the next.
    __resetOpenThreadForTest();
    setTheme(DEFAULT_THEME_ID);
});

// A minimal static Workspace: the test never swaps sessions, so a plain object (not the reactive
// store) is sufficient — the sidebar reads it like any props object.
function wsFor(analysis: Analysis, workingDir: string): Workspace {
    return {
        analysis,
        sessionId: "no-such-session", // no thread snapshot is seeded, so the SESSION detail row stays a placeholder
        workingDir,
        project: null,
        openDialog: () => {},
        closeDialog: () => {},
        openSession: () => {},
        quit: async () => {},
    };
}

// A full-height sidebar mounted under a given workspace — the shared shape the responsive cases render.
function sidebarNode(ws: Workspace) {
    return () => (
        <WorkspaceContext.Provider value={ws}>
            <box width="100%" height="100%">
                <Sidebar messageCount={() => 0} />
            </box>
        </WorkspaceContext.Provider>
    );
}

/** The first captured frame line containing `needle` (or ""), so a test can assert what shares a row. */
function lineContaining(frame: string, needle: string): string {
    return frame.split("\n").find((l) => l.includes(needle)) ?? "";
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
// workspace keeps the fixture minimal (no thread snapshot, no anchor/input reads), so only the two
// live sections vary between cases.
const fakeRuntime = { pool: {} } as unknown as HarnessRuntime;

function seams(profile: DataProfileStatus | null, runs: CortexRunRow[], steps: StepExecutionRow[] = []): RefreshSeams {
    return { runtime: () => fakeRuntime, loadProfile: () => okAsync(profile), loadRuns: () => okAsync(runs), loadSteps: () => okAsync(steps) };
}

function stepRow(stepId: string, status: StepExecutionRow["status"]): StepExecutionRow {
    return {
        runId: "run-1",
        stepId,
        analysisId: "a1",
        wave: 0,
        agentId: "agent-x",
        status,
        startedAt: status === "pending" ? null : "2026-07-08T00:00:01.000Z",
        completedAt: status === "completed" ? "2026-07-08T00:00:02.000Z" : null,
        durationMs: null,
        error: null,
        attempts: 1,
        lastErrorClass: null,
        finishReason: null,
        hitMaxSteps: false,
        blockedReason: null,
        sandboxRef: null,
        execId: null,
        childWorkflowId: null,
    };
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
        synthesisStatus: null,
        synthesisReason: null,
        parts: null,
        mandateJti: null,
        mandateExpiresAt: null,
        planId: null,
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

    test("a completed profile shows the file count and the absolute completed time; no runs shows 'no runs'", async () => {
        await refreshSidebarData("A", seams(completedProfile(2), []));
        const frame = await renderFrame(liveNode(), { width: 44, height: 24 });
        expect(frame).toContain("2 files");
        // The completed-profile rail line is a durable-record readout: it pins the absolute local
        // completed time (toLocaleString, via absTime) so the rail matches the details dialog — NOT a
        // compact relative age. Assert the same absolute token the row computes.
        expect(frame).toContain(absTime("2026-07-08T00:00:05.000Z"));
        expect(frame).toContain("no runs");
    });

    test("a running profile shows 'profiling…'", async () => {
        await refreshSidebarData("A", seams({ ...completedProfile(0), status: "running", result: null, completedAt: null }, []));
        const frame = await renderFrame(liveNode(), { width: 44, height: 24 });
        expect(frame).toContain("profiling");
    });

    test("runs render newest by run-id tail (not the constant workflow name) with a relative age; an unprofiled analysis reads 'not profiled'", async () => {
        await refreshSidebarData("A", seams(null, [runRow({ runId: "run-aabbccddeeff", status: "running" })]));
        const frame = await renderFrame(liveNode(), { width: 44, height: 24 });
        // The row is keyed by the run's id tail — the per-run distinguisher — NOT "executeAnalysis",
        // which is the identical workflow name on every run.
        expect(frame).toContain(idTail("run-aabbccddeeff"));
        expect(frame).not.toContain("executeAnalysis");
        expect(frame).toContain("not profiled");
        // A LIVE run stays in the compact relative-age vocabulary (only finished runs pin an
        // absolute time). Assert the same relative token the row computes, and that no full
        // local timestamp leaks onto a still-running run's row.
        expect(frame).toContain(relAge("2026-07-08T00:00:00.000Z"));
        expect(frame).not.toContain(new Date("2026-07-08T00:00:00.000Z").toLocaleString());
    });
});

// The SESSION section renders the `hooks/thread.ts` snapshot: a placeholder ladder for every degraded
// kind, and the pg-owned title + relative age once a row loads. Each case drives the REAL store through
// `refreshOpenThread`'s injectable reads (no Postgres, no booted runtime) and asserts the rail text.
// The placeholder strings are shared with DATA PROFILE / RUNS ("runtime not ready", "unavailable"), so
// every assertion is scoped to the lines the SESSION section owns rather than the whole frame.
describe("Sidebar SESSION section", () => {
    // A UUIDv7-shaped thread id, as `resolveThreadId` mints. Its handle head (`0198`) is deliberately
    // absent from every other fixture string below, so a frame assertion can never confuse the two.
    const THREAD_ID = "01988cdd-7f00-7abc-8def-0123456789ab";
    const TITLE = "Ribosome occupancy sweep";
    // Old enough that the readout sits in the days bucket, and offset half an hour off the boundary so
    // the rendered `Nd..h` token cannot flip between the render and the assertion.
    const CREATED_AT = new Date(Date.now() - (3 * 24 + 4) * 3_600_000 - 30 * 60_000);
    const dbErr: DbError = { type: "query_failed", op: "test", cause: new Error("boom") };

    function threadRow(over: Partial<Thread> = {}): Thread {
        return { threadId: THREAD_ID, analysisId: "a1", title: TITLE, createdAt: CREATED_AT, updatedAt: CREATED_AT, ...over };
    }

    /** Thread seams whose row read resolves to `row` (or fails when `row` is the error sentinel). */
    function threadSeams(read: () => ReturnType<ThreadSeams["getThread"]>): ThreadSeams {
        return {
            runtime: () => fakeRuntime,
            listThreads: () => okAsync({ threads: [], total: 0, page: 0, perPage: 20, hasMore: false }),
            getThread: read,
            notify: () => {},
        };
    }

    // A workspace with a BOUND thread and a distinct message count, so the loaded line's three fields
    // (title, age, count) are each distinguishable from one another in the frame.
    function sessionNode(messageCount: number) {
        const ws = {
            analysis: null,
            sessionId: THREAD_ID,
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
                    <Sidebar messageCount={() => messageCount} />
                </box>
            </WorkspaceContext.Provider>
        );
    }

    /**
     * Whether `needle` renders on a line the SESSION section owns — the rows between its label row and
     * the next section's. Line-scoped rather than frame-scoped because the rail's placeholder strings
     * are shared with DATA PROFILE / RUNS, and each captured row also carries the rail border + scrollbar.
     */
    function sessionHas(frame: string, needle: string): boolean {
        const lines = frame.split("\n");
        const start = lines.findIndex((l) => l.includes("SESSION"));
        if (start < 0) return false;
        const after = lines.slice(start + 1);
        const end = after.findIndex((l) => l.includes("ANALYSIS"));
        return (end < 0 ? after : after.slice(0, end)).some((l) => l.includes(needle));
    }

    test("no thread bound yet (pre-ready) shows the runtime placeholder", async () => {
        await refreshOpenThread(
            null,
            threadSeams(() => okAsync(threadRow())),
        );
        const frame = await renderFrame(sessionNode(0), { width: 44, height: 24 });
        expect(sessionHas(frame, "runtime not ready")).toBe(true);
        expect(frame).not.toContain(TITLE);
    });

    test("a failed row read degrades to 'unavailable', never a crash or a blank rail", async () => {
        await refreshOpenThread(
            THREAD_ID,
            threadSeams(() => errAsync(dbErr)),
        );
        const frame = await renderFrame(sessionNode(0), { width: 44, height: 24 });
        expect(sessionHas(frame, "unavailable")).toBe(true);
        expect(frame).not.toContain(TITLE);
    });

    test("a bound id with no row reads 'new conversation' — the first turn has yet to create it", async () => {
        await refreshOpenThread(
            THREAD_ID,
            threadSeams(() => okAsync(null)),
        );
        const frame = await renderFrame(sessionNode(0), { width: 44, height: 24 });
        expect(sessionHas(frame, "new conversation")).toBe(true);
        // The handle still rides the label row: an identity exists, only its row does not.
        expect(lineContaining(frame, "SESSION")).toContain("0198");
    });

    test("a loaded row renders the pg title, its relative age, and the live message count", async () => {
        await refreshOpenThread(
            THREAD_ID,
            threadSeams(() => okAsync(threadRow())),
        );
        const frame = await renderFrame(sessionNode(7), { width: 44, height: 24 });

        expect(sessionHas(frame, TITLE)).toBe(true);
        // Asserted through the same formatter the row computes, never a hardcoded token.
        expect(sessionHas(frame, Date.relativeAge(CREATED_AT.getTime()))).toBe(true);
        expect(sessionHas(frame, "7 msgs")).toBe(true);
        // The degraded ladder is fully replaced — no placeholder survives beside a real title.
        expect(sessionHas(frame, "new conversation")).toBe(false);
        expect(sessionHas(frame, "runtime not ready")).toBe(false);
    });

    test("a row whose title the first message has not seeded yet reads 'untitled', not a blank line", async () => {
        await refreshOpenThread(
            THREAD_ID,
            threadSeams(() => okAsync(threadRow({ title: null }))),
        );
        const frame = await renderFrame(sessionNode(1), { width: 44, height: 24 });
        expect(sessionHas(frame, "untitled")).toBe(true);
    });

    // A character frame carries no color, so it cannot tell a correctly-painted title from one that fell
    // through to opentui's opaque-white default — on `github-light` (bg pure #ffffff) that default is
    // 1.00:1, fully invisible, and `toContain(TITLE)` passes identically either way. Assert the resolved
    // span fg instead, which is the only mechanism that can see this defect class.
    test("the loaded title paints the theme foreground on a light theme, not the white default", async () => {
        setTheme("github-light");
        await refreshOpenThread(
            THREAD_ID,
            threadSeams(() => okAsync(threadRow())),
        );
        const setup = await testRender(sessionNode(7), { width: 44, height: 24 });
        try {
            await setup.renderOnce();
            let titleFg: RGBA | undefined;
            for (const line of setup.captureSpans().lines) {
                for (const span of line.spans) {
                    if (span.text.includes(TITLE)) titleFg = span.fg;
                }
            }
            expect(titleFg).toBeDefined();
            expect(titleFg && rgbToHex(titleFg)).not.toBe("#ffffff");
            expect(titleFg && parseColor(themes["github-light"].colors.fg).equals(titleFg)).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("Sidebar RUNS progress embed", () => {
    test("an active newest run renders its bar and step window under the run row, without repeating the id", async () => {
        const steps = [stepRow("s1_cohort_summary", "completed"), stepRow("s2_mutation_assoc", "running"), stepRow("s3_clinical_assoc", "pending")];
        await refreshSidebarData("A", seams(null, [runRow({ runId: "run-aabbccddeeff", status: "running" })], steps));
        const frame = await renderFrame(liveNode(), { width: 44, height: 30 });

        expect(frame).toContain("1/3");
        expect(frame).toContain("s1_cohort_summary");
        expect(frame).toContain("s2_mutation_assoc");
        expect(frame).toContain("s3_clinical_assoc");
        // The seeded `pending` row renders through the queued (hollow) glyph on the same line.
        expect(lineContaining(frame, "s3_clinical_assoc")).toContain(GLYPHS.circleHollow);
        expect(lineContaining(frame, "s1_cohort_summary")).toContain(GLYPHS.check);
        // heading={false}: the run row above is the only place the id tail appears (the embed carries
        // it as a `tag`, but the run row's copy is the sole textual occurrence at this width).
        expect(frame.split(idTail("run-aabbccddeeff")).length - 1).toBe(1);
    });

    test("a terminal newest run renders plain rows — no bar, no step window", async () => {
        await refreshSidebarData("A", seams(null, [runRow({ runId: "run-aabbccddeeff", status: "completed", completedAt: "2026-07-08T00:01:00.000Z" })]));
        const frame = await renderFrame(liveNode(), { width: 44, height: 24 });
        expect(frame).toContain(idTail("run-aabbccddeeff"));
        // A finished run pins its absolute completion time — a durable record read long after a
        // relative age lost its anchor — in the rail's compact form, which shares one fixed-width
        // row with the workflow name (the long absTime form would soft-wrap mid-token).
        expect(frame).toContain(absTimeShort("2026-07-08T00:01:00.000Z"));
        expect(frame).not.toContain(relAge("2026-07-08T00:00:00.000Z"));
        // The meter's segmented bar is the embed's signature (a "/" would also match the absolute
        // date's slashes, so the glyph is the honest absence check).
        expect(frame).not.toContain(GLYPHS.bar);
    });

    test("the rail lists at most the newest 3 runs", async () => {
        // Distinct run ids (the row's distinguisher now the workflow name is dropped) so the cap is
        // asserted on what actually varies row to row. Assert through idTail — it strips dashes and
        // takes the last 6, so a literal would drift from what the row prints.
        const runIds = ["run-000001", "run-000002", "run-000003", "run-000004"];
        const runs = runIds.map((runId) => runRow({ runId, status: "completed", completedAt: "2026-07-08T00:01:00.000Z" }));
        await refreshSidebarData("A", seams(null, runs));
        const frame = await renderFrame(liveNode(), { width: 44, height: 24 });
        expect(frame).toContain(idTail("run-000001"));
        expect(frame).toContain(idTail("run-000002"));
        expect(frame).toContain(idTail("run-000003"));
        expect(frame).not.toContain(idTail("run-000004"));
    });

    test("short terminals keep the top of the rail intact (the pane scrolls; sections are not squeezed away)", async () => {
        const steps = [stepRow("s1_cohort_summary", "completed"), stepRow("s2_mutation_assoc", "running"), stepRow("s3_clinical_assoc", "pending")];
        await refreshSidebarData("A", seams(completedProfile(2), [runRow({ status: "running" })], steps));
        // Size-dependent layout bugs hide at any single size — sweep several short heights.
        for (const height of [10, 14, 18]) {
            const frame = await renderFrame(liveNode(), { width: 44, height });
            expect(frame).toContain("SESSION");
            expect(frame).toContain("ANALYSIS");
        }
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

// The connection line rides the immutable boot-ready state, so each case
// seeds a `ready` boot with the connection identity AND a non-empty agentModels (the section body is
// gated on the switch's authority). It renders above the agent rows in both connection modes, and
// carries ONLY the provider slug — the mode is deliberately absent from the rail (the Status dialog
// owns the full connection detail).
describe("Sidebar MODELS connection line", () => {
    test("cliproxy: shows the provider slug above the agent rows, never the mode", async () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        __setAgentModelsForTest({ current: { conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5" }, pending: new Map() });
        const frame = await renderFrame(liveNode(), { width: 44, height: 24 });
        expect(frame).toContain("MODELS");
        expect(frame).toContain("conn");
        expect(frame).toContain("anthropic"); // the configured provider slug
        expect(frame).not.toContain("cliproxy"); // the mode belongs to the Status dialog, not the rail
    });

    test("direct: shows the configured provider slug, never the mode", async () => {
        __setBootStateForTest({ phase: "ready", model: "deepseek-chat", connection: { provider: "deepseek", mode: "direct" } });
        __setAgentModelsForTest({ current: { conversation: "deepseek-chat", sandbox: "deepseek-reasoner" }, pending: new Map() });
        const frame = await renderFrame(liveNode(), { width: 44, height: 24 });
        expect(frame).toContain("conn");
        expect(frame).toContain("deepseek"); // the configured provider slug
        expect(frame).not.toContain("direct"); // the mode belongs to the Status dialog, not the rail
    });
});

// The ANALYSIS anchor-marker badge is shown in exactly one place, chosen by terminal width: its own
// path line below the breakpoint, or prefixed to the meta line at/above it (where the path is dropped).
// 119/121 straddle `size.breakpointWide` (120); the rail itself stays a fixed width, so only this
// terminal-width flip changes here. A real analysis is created so getAnchor returns a live marker.
describe("Sidebar responsive ANALYSIS badge + path", () => {
    test("narrow: the badge + path own their line; the meta line carries no badge", async () => {
        writeFileSync(join(dirA, "one.txt"), "x");
        const a = createAnalysis({ cwd: dirA, name: str256("alpha")._unsafeUnwrap(), inputPaths: [join(dirA, "one.txt")] })._unsafeUnwrap();
        const anchor = getAnchor(a.anchorId)._unsafeUnwrap();
        // The head of the resolved path is short enough to land on the first wrapped rail line.
        const pathHead = anchor!.cachedPath.slice(0, 20);

        const frame = await renderFrame(sidebarNode(wsFor(a, dirA)), { width: 119, height: 24 });
        expect(frame).toContain(pathHead); // the path renders below the breakpoint
        expect(lineContaining(frame, pathHead)).toContain(GLYPHS.check); // badge leads the path line
        expect(lineContaining(frame, "input")).not.toContain(GLYPHS.check); // meta line has no badge
    });

    test("wide: the path line disappears and the badge joins the meta line", async () => {
        writeFileSync(join(dirA, "one.txt"), "x");
        const a = createAnalysis({ cwd: dirA, name: str256("alpha")._unsafeUnwrap(), inputPaths: [join(dirA, "one.txt")] })._unsafeUnwrap();
        const anchor = getAnchor(a.anchorId)._unsafeUnwrap();
        const pathHead = anchor!.cachedPath.slice(0, 20);

        const frame = await renderFrame(sidebarNode(wsFor(a, dirA)), { width: 121, height: 24 });
        expect(frame).not.toContain(pathHead); // no path line at/above the breakpoint
        const meta = lineContaining(frame, "input");
        expect(meta).toContain(`${GLYPHS.check} `); // the badge now prefixes the meta line
        expect(meta).toContain("1 input");
    });
});

// A Section merges its value onto the label row when it fits the rail's usable width, else stacks it
// on the line below — the rail is a fixed width, so this depends on value length, not terminal width.
describe("Sidebar Section header merge vs stacked fallback", () => {
    test("a short ASCII value shares its section's label row; a middot-bearing handle merges too", async () => {
        writeFileSync(join(dirA, "one.txt"), "x");
        const a = createAnalysis({ cwd: dirA, name: str256("alpha")._unsafeUnwrap(), inputPaths: [join(dirA, "one.txt")] })._unsafeUnwrap();
        const frame = await renderFrame(sidebarNode(wsFor(a, dirA)), { width: 44, height: 24 });
        expect(lineContaining(frame, "ANALYSIS")).toContain("alpha"); // pure-ASCII name is cell-accurate → merges up
        // The SESSION handle is `S·nosu` — its `·` is GLYPHS.middot, a single-cell registry glyph the fit
        // check trusts as width 1, so the whole handle (well within the rail) merges onto the label row.
        expect(lineContaining(frame, "SESSION")).toContain("nosu");
    });

    test("a value too long to fit stacks below the label, rendered in full (never truncated)", async () => {
        writeFileSync(join(dirA, "one.txt"), "x");
        const longName = "long-analysis-name-that-will-not-fit";
        const a = createAnalysis({ cwd: dirA, name: str256(longName)._unsafeUnwrap(), inputPaths: [join(dirA, "one.txt")] })._unsafeUnwrap();
        const frame = await renderFrame(sidebarNode(wsFor(a, dirA)), { width: 44, height: 24 });
        expect(lineContaining(frame, "ANALYSIS")).not.toContain(longName); // label row holds only the label
        expect(frame).toContain(longName); // the name renders in full on its own line
    });

    test("a non-ASCII (CJK) name stacks even when its .length would fit, since cells ≠ UTF-16 units", async () => {
        writeFileSync(join(dirA, "one.txt"), "x");
        // `分析proj`: .length is 6, so the old unit-count check would MERGE it onto the label row — but the
        // two CJK glyphs are two cells each, so that fit is measured wrong. The conservative guard stacks
        // any non-ASCII value instead. The ASCII `proj` tail is the reliable capture probe (wide-glyph
        // capture is not); the workspace has no linked project, so `proj` appears only in the name.
        const a = createAnalysis({ cwd: dirA, name: str256("分析proj")._unsafeUnwrap(), inputPaths: [join(dirA, "one.txt")] })._unsafeUnwrap();
        const frame = await renderFrame(sidebarNode(wsFor(a, dirA)), { width: 44, height: 24 });
        expect(lineContaining(frame, "ANALYSIS")).not.toContain("proj"); // did not merge onto the label row
        expect(frame).toContain("proj"); // stacked on its own full line below the label
    });
});

// The embed's elision markers are click targets that scroll its step window, and they sit INSIDE the
// RUNS Section — whose own mouse-up opens the runs picker. opentui propagates mouse events, so without
// containment every scroll click would also pop a dialog over the rail. These pin both halves: the
// marker click is swallowed, and an ordinary click elsewhere in the section still opens the picker.
describe("Sidebar RUNS progress embed — window scroll containment", () => {
    // Twelve steps with the frontier at s8: past the rail window's break-even point, and hiding steps on
    // BOTH sides, so each marker renders and can be clicked.
    function longRunSteps(): StepExecutionRow[] {
        return [
            ...["s1", "s2", "s3", "s4", "s5", "s6", "s7"].map((id) => stepRow(id, "completed" as const)),
            stepRow("s8", "running"),
            ...["s9", "s10", "s11", "s12"].map((id) => stepRow(id, "pending" as const)),
        ];
    }

    function runsNode(onOpenRuns: () => void) {
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
                    <Sidebar messageCount={() => 0} onOpenRuns={onOpenRuns} />
                </box>
            </WorkspaceContext.Provider>
        );
    }

    test("clicking an elision marker scrolls the window and does NOT open the runs picker", async () => {
        let opened = 0;
        await refreshSidebarData("A", seams(null, [runRow({ status: "running" })], longRunSteps()));
        const setup = await testRender(
            runsNode(() => opened++),
            { width: 44, height: 34 },
        );
        try {
            await setup.renderOnce();
            expect(setup.captureCharFrame()).toContain("4 earlier steps");

            const lines = setup.captureCharFrame().split("\n");
            const y = lines.findIndex((l) => l.includes(GLYPHS.arrowUp));
            expect(y).toBeGreaterThanOrEqual(0);
            await setup.mockMouse.click(lines[y]!.indexOf(GLYPHS.arrowUp), y);
            await setup.renderOnce();

            // The window moved one step earlier...
            expect(setup.captureCharFrame()).toContain("3 earlier steps");
            // ...and the section's activation never fired, so no picker covered the rail.
            expect(opened).toBe(0);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("containment is narrow — a click elsewhere in the RUNS section still opens the picker", async () => {
        let opened = 0;
        await refreshSidebarData("A", seams(null, [runRow({ status: "running" })], longRunSteps()));
        const setup = await testRender(
            runsNode(() => opened++),
            { width: 44, height: 34 },
        );
        try {
            await setup.renderOnce();
            const lines = setup.captureCharFrame().split("\n");
            const y = lines.findIndex((l) => l.includes("RUNS"));
            expect(y).toBeGreaterThanOrEqual(0);
            await setup.mockMouse.click(lines[y]!.indexOf("RUNS"), y);
            await setup.renderOnce();
            expect(opened).toBe(1);
        } finally {
            setup.renderer.destroy();
        }
    });
});
