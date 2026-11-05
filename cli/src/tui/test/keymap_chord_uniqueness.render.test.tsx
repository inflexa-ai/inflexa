import { describe, expect, test } from "bun:test";
import { okAsync } from "neverthrow";
import { testRender } from "@opentui/solid";

import type { RunDetail, RunSummary } from "../../api/runs.ts";
import { asStr256 } from "../../lib/types.ts";
import { App } from "../app.tsx";
import { refreshSidebarData, type RefreshOpts } from "../hooks/sidebar_live.ts";
import { dispatchKey, leaderKeybind, reachableKeys, resolveKeybind, type KeyLike } from "../keymap.ts";
import type { Analysis } from "../../types/analysis.ts";
import { present } from "../../lib/present.ts";
import { appRenderLifecycle } from "../../test_support/app_render.ts";

// The keymap dispatches the FIRST full match of a chord, and `reachableKeys`
// dedupes on stroke plus desc. Thus two bindings on one chord ship silently:
// the which-key panel lists both, and only one can ever fire. This mounts the
// real `App` — the real binding table — arms the leader, and requires each
// reachable stroke to be unique. A collision anywhere in the app layer fails
// here by name, not in a user's terminal. A layer that is disabled is absent
// from the sweep, thus the test seeds an active run, which enables the abort
// layer of the activity panel.

// `ready` opens every gated layer, thus the sweep sees the full table; the lifecycle's cleanup stops
// any of the stores or singletons from leaking into a sibling file.
const { dir } = appRenderLifecycle("inflexa-chords-");

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
    loadRun: () => okAsync<RunDetail>({ ...activeRun, steps: [], plan: null, unattributedUsage: null }),
};

describe("the chord table of App", () => {
    test("each stroke reachable from the leader is unique", async () => {
        const setup = await testRender(() => <App workingDir={dir()} analysis={analysis} />, { width: 100, height: 26 });
        try {
            // After the mount: the first refresh of `App` uses the production reads, and it would wipe an earlier seed.
            await refreshSidebarData(analysis.id, seedOpts);
            await Promise.sleep(20);
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
            const abortStroke = present(leaderKeybind("app.activity-panel-abort")[1]).key;
            expect(byStroke.get(abortStroke)).toBe("Abort the active run");
        } finally {
            dispatchKey(key("escape"));
            setup.renderer.destroy();
        }
    });
});
