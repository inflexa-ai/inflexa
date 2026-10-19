import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { okAsync } from "neverthrow";
import { testRender } from "@opentui/solid";

import type { RunDetail, RunSummary } from "../api/runs.ts";
import { asStr256 } from "../lib/types.ts";
import { App } from "./app.tsx";
import { dialogClear } from "./components/dialog/dialog_host.tsx";
import { __setAgentModelsForTest, __setBootStateForTest } from "./hooks/boot.ts";
import { __resetNoticesForTest } from "./hooks/notice.ts";
import { __resetActivityPanelForTest } from "./hooks/activity_panel.ts";
import { __resetRunCompletionsForTest } from "./hooks/run_completion.ts";
import { __resetSidebarLiveForTest, refreshSidebarData, type RefreshOpts } from "./hooks/sidebar_live.ts";
import { resetHotState } from "./hooks/conversation.ts";
import { dispatchKey, leaderKeybind, reachableKeys, resolveKeybind, type KeyLike } from "./keymap.ts";
import type { Analysis } from "../types/analysis.ts";

// The keymap dispatches the FIRST full match of a chord, and `reachableKeys`
// dedupes on stroke plus desc. Thus two bindings on one chord ship silently:
// the which-key panel lists both, and only one can ever fire. This mounts the
// real `App` — the real binding table — arms the leader, and requires each
// reachable stroke to be unique. A collision anywhere in the app layer fails
// here by name, not in a user's terminal. A layer that is disabled is absent
// from the sweep, thus the test seeds an active run, which enables the abort
// layer of the activity panel.

let dir = "";

/** The open analysis: a plain row, because `App` reads its fields and the server keeps the rest. */
const analysis: Analysis = {
    id: "analysis-chords",
    createdAt: 0,
    updatedAt: 0,
    name: asStr256("chord-test"),
    slug: "chord-test",
    anchorId: "anchor-chords",
    projectId: null,
};

function key(name: string, mods: Partial<Pick<KeyLike, "ctrl" | "meta" | "option" | "shift">> = {}): KeyLike & { preventDefault: () => void } {
    return { name, ctrl: false, meta: false, option: false, shift: false, ...mods, preventDefault: () => {} };
}

/** One running run, read through the same door as production: `refreshSidebarData`. */
const activeRun: RunSummary = {
    runId: "run-chords",
    threadId: null,
    planId: null,
    workflowName: "executeAnalysis",
    workflowId: "run-chords",
    status: "running",
    startedAt: "2026-07-28T10:00:00.000Z",
    completedAt: null,
    error: null,
    planTitle: "Differential expression",
};

const seedOpts: RefreshOpts = {
    ready: () => true,
    loadProfile: () => okAsync({ status: null }),
    loadRuns: () => okAsync([activeRun]),
    loadActiveRuns: () => okAsync([activeRun]),
    loadRun: () => okAsync<RunDetail, never>({ ...activeRun, steps: [], plan: null, unattributedUsage: null }),
};

beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-chords-")));
    // `ready` opens every gated layer, thus the sweep sees the full table.
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

describe("the chord table of App", () => {
    test("each stroke reachable from the leader is unique", async () => {
        const setup = await testRender(() => <App workingDir={dir} analysis={analysis} />, { width: 100, height: 26 });
        try {
            // After the mount: the first refresh of `App` uses the production reads, and it would wipe an earlier seed.
            await refreshSidebarData(analysis.id, seedOpts);
            await new Promise((r) => setTimeout(r, 20));
            await setup.renderOnce();

            const leader = resolveKeybind("app.leader");
            expect(dispatchKey({ ...key(leader.key, { ctrl: leader.ctrl ?? false, shift: leader.shift ?? false }) })).toBe(true);

            const reachable = reachableKeys();
            expect(reachable.length).toBeGreaterThan(0);
            const strokes = reachable.map((next) => next.stroke);
            const collisions = strokes.filter((stroke, index) => strokes.indexOf(stroke) !== index);
            expect(collisions).toEqual([]);

            // The two chords of the historical collision, apart and named.
            const byStroke = new Map(reachable.map((next) => [next.stroke, next.desc]));
            expect(byStroke.get("t")).toBe("Change theme");
            expect(byStroke.get("f")).toBe("Retry failed transfers");

            // The abort layer is enabled by the seeded run, thus its stroke takes part in the sweep.
            const abortStroke = leaderKeybind("app.activity-panel-abort")[1]!.key;
            expect(byStroke.get(abortStroke)).toBe("Abort the active run");
        } finally {
            dispatchKey(key("escape"));
            setup.renderer.destroy();
        }
    });
});
