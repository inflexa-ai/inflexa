import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { okAsync } from "neverthrow";
import { parseColor } from "@opentui/core";
import { testRender } from "@opentui/solid";

import type { CancelRunResult, DataProfileState, RunDetail, RunSummary } from "../api/runs.ts";
import { DEFAULT_CLIENT_OPTS } from "../client/api.ts";
import { asStr256 } from "../lib/types.ts";
import { fakeClient } from "../test_support/fake_client.ts";
import { App } from "./app.tsx";
import { dialogClear, dialogIsOpen } from "./components/dialog/dialog_host.tsx";
import { __setAgentModelsForTest, __setBootStateForTest } from "./hooks/boot.ts";
import { __resetNoticesForTest, currentNotice } from "./hooks/notice.ts";
import { __resetActivityPanelForTest, focusedSubject, activityPanelVisible, toggleActivityPanel } from "./hooks/activity_panel.ts";
import { __resetRunCompletionsForTest } from "./hooks/run_completion.ts";
import { __resetSidebarLiveForTest, refreshSidebarData, type RefreshOpts } from "./hooks/sidebar_live.ts";
import { resetHotState } from "./hooks/conversation.ts";
import { dispatchKey, leaderKeybind, reachableKeys, resolveKeybind, type KeyLike } from "./keymap.ts";
import { theme } from "./theme.ts";
import type { Analysis } from "../types/analysis.ts";

// Every piece of the run-observability work is unit-tested in isolation; what nothing covered is
// `App`'s own COMPOSITION — that it mounts the panel between the stream and the input, that it calls
// the two watchers under its reactive owner, and that the panel really contributes zero rows when
// there is nothing to show. Those are exactly the joints a passing unit suite cannot vouch for, and
// the panel's placement is load-bearing (it sits under a flexGrow scrollbox, where a row that does
// not paint its own background lets scrolled content bleed through).
//
// This drives the REAL `App` against the REAL stores, seeding run state through `refreshSidebarData`
// with fake reads of the run endpoints — the same door production uses. No server runs: each read
// that `App` makes on its own fails to find one, and degrades.

let dir = "";

/** The open analysis: a plain row, because `App` reads its fields and the server keeps the rest. */
const analysis: Analysis = {
    id: "analysis-panel",
    createdAt: 0,
    updatedAt: 0,
    name: asStr256("panel-test"),
    slug: "panel-test",
    anchorId: "anchor-panel",
    projectId: null,
};

function runRow(over: Partial<RunSummary> & { runId: string }): RunSummary {
    return {
        threadId: null,
        planId: null,
        workflowName: "executeAnalysis",
        workflowId: over.runId,
        status: "running",
        startedAt: "2026-07-28T10:00:00.000Z",
        completedAt: null,
        error: null,
        planTitle: "Differential expression",
        ...over,
    };
}

function optsFor(runs: RunSummary[], profile?: DataProfileState): RefreshOpts {
    return {
        ready: () => true,
        loadProfile: () => okAsync(profile ?? { status: null }),
        loadRuns: () => okAsync(runs),
        loadActiveRuns: () => okAsync(runs.filter((r) => r.status === "running")),
        loadRun: (_analysisId, runId) => {
            const detail: RunDetail = {
                ...runRow({ runId }),
                steps: [
                    {
                        stepId: "T1S1",
                        name: "align reads",
                        agentId: "bioinformatician",
                        status: "running",
                        startedAt: null,
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
            return okAsync(detail);
        },
    };
}

beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-app-panel-")));
    // `ready` is what opens the input gate and stops the boot indicator claiming rows of its own.
    __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
    __setAgentModelsForTest({ current: { conversation: "m", sandbox: "m", utility: "m" }, efforts: null, pending: new Map() });
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    dialogClear();
    resetHotState();
    __resetSidebarLiveForTest();
    __resetActivityPanelForTest();
    __resetRunCompletionsForTest();
    __resetNoticesForTest();
    __setBootStateForTest({ phase: "idle" });
});

/**
 * Mount the real `App`, then hand back a `seed` + `frame` pair.
 *
 * Seeding must happen AFTER the mount, not before: `App` installs `watchSidebarData`, whose
 * ready-edge effect immediately refreshes with the PRODUCTION reads — and with no server those reads
 * degrade every snapshot. Anything seeded beforehand is wiped by the app's own first refresh, which
 * is exactly the race that made the first draft of this file flaky.
 */
async function mountApp(size = { width: 100, height: 26 }) {
    // No sessionId prop: App binds its thread only at the boot-ready edge, and with no server that
    // bind fails — the scope stays unbound and the transcript stays empty, which is the blank-chat
    // baseline these frames assert against.
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
        seed: (runs: RunSummary[], profile?: DataProfileState) => refreshSidebarData(analysis.id, optsFor(runs, profile)),
        frame: settle,
        spans: () => setup.captureSpans().lines.flatMap((line) => line.spans),
        destroy: () => setup.renderer.destroy(),
    };
}

describe("App composes the run-activity panel", () => {
    test("with an active run, the panel renders inside the chat column", async () => {
        const app = await mountApp();
        try {
            await app.seed([runRow({ runId: "run-a" })]);
            expect(activityPanelVisible()).toBe(true);
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
            expect(activityPanelVisible()).toBe(false);
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

            toggleActivityPanel();
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
            // With no server, the thread bind of the mount raises its own notice. Clear it, so the
            // notice below can only be the announcement.
            __resetNoticesForTest();
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

function key(name: string, mods: Partial<Pick<KeyLike, "ctrl" | "shift">> = {}): KeyLike & { preventDefault: () => void } {
    return { name, ctrl: false, meta: false, option: false, shift: false, ...mods, preventDefault: () => {} };
}

/** Push each stroke of the abort chord through the central dispatch, the way the root key handler does. */
function pushAbortChord(): void {
    for (const stroke of leaderKeybind("app.activity-panel-abort")) {
        dispatchKey(key(stroke.key, { ctrl: stroke.ctrl ?? false, shift: stroke.shift ?? false }));
    }
}

/** Push the leader alone, so the which-key overlay and `reachableKeys` list the strokes that follow. */
function pushLeader(): void {
    const leader = resolveKeybind("app.leader");
    dispatchKey(key(leader.key, { ctrl: leader.ctrl ?? false, shift: leader.shift ?? false }));
}

/** A running data-profile row, the one shape the refresh publishes as a panel subject. */
const runningProfile: DataProfileState = {
    status: "running",
    error: null,
    startedAt: "2026-07-28T10:00:00.000Z",
    completedAt: null,
    result: null,
    workflowId: "wf-profile-panel",
    seedInputFileIds: ["input-1"],
};

const ABORT_DESC = "Abort the active run";

/**
 * A server for the cancel of `run-a`: the real client of the abort (`cancelRun` on the default client
 * opts) reaches this fake, and `cancels` lists the cancel requests it saw, in order. Every other route
 * answers 404, as the app degrades without a server. `restore` puts the default client opts back.
 */
function stubCancelServer(): { cancels: () => { method: string; path: string }[]; restore: () => void } {
    const canceled: CancelRunResult = {
        runId: "run-a",
        workflowId: "run-a",
        outcome: "canceled",
        finalStatus: "canceled",
        converged: { steps: true, charge: true, mandate: true },
    };
    const client = fakeClient((req) => {
        if (req.method === "POST" && req.path.endsWith("/cancel")) return { status: 200, body: canceled };
        return { status: 404, body: { error: "not_found", message: `No route for ${req.method} ${req.path}.` } };
    });
    const discover = spyOn(DEFAULT_CLIENT_OPTS, "discover").mockImplementation(() => client.opts.discover());
    const fetch = spyOn(DEFAULT_CLIENT_OPTS, "fetch").mockImplementation((url, init) => client.opts.fetch(url, init));
    return {
        cancels: () => client.requests.filter((req) => req.method === "POST" && req.path.endsWith("/cancel")).map(({ method, path }) => ({ method, path })),
        restore: () => {
            discover.mockRestore();
            fetch.mockRestore();
        },
    };
}

/** Wait until `done` holds, so a flow that crosses the client and the stores has ended before the test reads its state. */
async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
}

describe("App binds the abort of the focused run", () => {
    test("the chord opens the danger confirmation for the run, with keep running active", async () => {
        const app = await mountApp();
        try {
            await app.seed([runRow({ runId: "run-a" })]);
            __resetNoticesForTest();
            expect(dialogIsOpen()).toBe(false);

            pushAbortChord();
            const frame = await app.frame();

            expect(dialogIsOpen()).toBe(true);
            // The message names the run; the panel row also carries the name, so the question is the needle.
            expect(frame).toContain("Abort Differential expression?");
            expect(frame).toContain("cannot resume");
            expect(frame).toContain("keep running");

            // A frame holds no color, so the tone is asserted on the resolved spans: the border glyph of
            // the danger chrome is double-stroked and painted in the error color, the title too.
            const colors = theme();
            const spans = app.spans();
            const corner = spans.find((span) => span.text.includes("\u2554"));
            expect(corner).toBeDefined();
            expect(parseColor(colors.error).equals(corner!.fg)).toBe(true);
            const title = spans.find((span) => span.text.includes("Abort run"));
            expect(title && parseColor(colors.error).equals(title.fg)).toBe(true);

            // The active choice is the one painted onAccent; the other choice stays muted.
            const keep = spans.find((span) => span.text === "keep running");
            const confirm = spans.find((span) => span.text === "confirm");
            expect(keep && parseColor(colors.onAccent).equals(keep.fg)).toBe(true);
            expect(confirm && parseColor(colors.fgMuted).equals(confirm.fg)).toBe(true);
        } finally {
            dispatchKey(key("escape"));
            app.destroy();
        }
    });

    test("enter on the default choice keeps the run: the dialog closes and no notice shows", async () => {
        const app = await mountApp();
        try {
            await app.seed([runRow({ runId: "run-a" })]);
            __resetNoticesForTest();

            pushAbortChord();
            await app.frame();
            expect(dialogIsOpen()).toBe(true);

            dispatchKey(key("return"));
            for (let i = 0; i < 6; i++) await Promise.resolve();

            expect(dialogIsOpen()).toBe(false);
            expect(currentNotice()).toBeNull();
            const subject = focusedSubject();
            expect(subject?.kind === "run" ? subject.run.runId : null).toBe("run-a");
        } finally {
            dispatchKey(key("escape"));
            app.destroy();
        }
    });

    test("confirming sends the cancel for the named run and closes the dialog", async () => {
        const app = await mountApp();
        const server = stubCancelServer();
        try {
            await app.seed([runRow({ runId: "run-a" })]);
            pushAbortChord();
            await app.frame();
            expect(dialogIsOpen()).toBe(true);

            // The active choice starts on keep running; right moves it to confirm, and Enter presses it.
            dispatchKey(key("right"));
            dispatchKey(key("return"));
            await until(() => server.cancels().length > 0);
            await app.frame();

            expect(server.cancels()).toEqual([{ method: "POST", path: "/api/v1/analyses/analysis-panel/run/run-a/cancel" }]);
            expect(dialogIsOpen()).toBe(false);
        } finally {
            server.restore();
            dispatchKey(key("escape"));
            app.destroy();
        }
    });

    test("esc sends no cancel and closes the dialog", async () => {
        const app = await mountApp();
        const server = stubCancelServer();
        try {
            await app.seed([runRow({ runId: "run-a" })]);
            pushAbortChord();
            await app.frame();
            expect(dialogIsOpen()).toBe(true);

            dispatchKey(key("escape"));
            await app.frame();

            expect(dialogIsOpen()).toBe(false);
            expect(server.cancels()).toEqual([]);
            const subject = focusedSubject();
            expect(subject?.kind === "run" ? subject.run.runId : null).toBe("run-a");
        } finally {
            server.restore();
            app.destroy();
        }
    });

    test("the chord under the open dialog opens no second dialog", async () => {
        const app = await mountApp();
        const server = stubCancelServer();
        try {
            await app.seed([runRow({ runId: "run-a" })]);
            pushAbortChord();
            await app.frame();
            expect(dialogIsOpen()).toBe(true);

            pushAbortChord();
            await app.frame();

            // One esc closes the one dialog. A second dialog on the stack would stay open.
            dispatchKey(key("escape"));
            await app.frame();
            expect(dialogIsOpen()).toBe(false);
            expect(server.cancels()).toEqual([]);
        } finally {
            server.restore();
            dispatchKey(key("escape"));
            app.destroy();
        }
    });

    test("while a profile shows, the chord opens nothing", async () => {
        const app = await mountApp();
        try {
            await app.seed([], runningProfile);
            expect(focusedSubject()?.kind).toBe("profile");
            expect(activityPanelVisible()).toBe(true);

            pushAbortChord();
            await app.frame();

            expect(dialogIsOpen()).toBe(false);
        } finally {
            dispatchKey(key("escape"));
            app.destroy();
        }
    });

    test("the which-key overlay lists the binding only while a run shows", async () => {
        const app = await mountApp();
        try {
            const abortKey = leaderKeybind("app.activity-panel-abort")[1]!.key;
            const listed = () => reachableKeys().some((next) => next.stroke === abortKey && next.desc === ABORT_DESC);

            await app.seed([runRow({ runId: "run-a" })]);
            pushLeader();
            expect(listed()).toBe(true);
            expect(await app.frame()).toContain(ABORT_DESC);
            dispatchKey(key("escape"));

            // A hidden panel is not a panel that shows a run.
            toggleActivityPanel();
            pushLeader();
            expect(listed()).toBe(false);
            expect(await app.frame()).not.toContain(ABORT_DESC);
            dispatchKey(key("escape"));
            toggleActivityPanel();

            // A profile shows next: the run ended and only the profile is active.
            await app.seed([runRow({ runId: "run-a", status: "completed", completedAt: "2026-07-28T10:01:00.000Z" })], runningProfile);
            expect(focusedSubject()?.kind).toBe("profile");
            pushLeader();
            expect(listed()).toBe(false);
            expect(await app.frame()).not.toContain(ABORT_DESC);
        } finally {
            dispatchKey(key("escape"));
            app.destroy();
        }
    });
});
