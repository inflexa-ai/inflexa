import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";

import { freshDb } from "../test_support/db.ts";
import { str256 } from "../lib/types.ts";
import { createAnalysis } from "../modules/analysis/analysis.ts";
import { App } from "./app.tsx";
import { dialogClear } from "./components/dialog/dialog_host.tsx";
import { __setAgentModelsForTest, __setBootStateForTest } from "./hooks/boot.ts";
import { __resetNoticesForTest } from "./hooks/notice.ts";
import { __resetActivityPanelForTest } from "./hooks/activity_panel.ts";
import { __resetRunCompletionsForTest } from "./hooks/run_completion.ts";
import { __resetSidebarLiveForTest } from "./hooks/sidebar_live.ts";
import { resetHotState } from "./hooks/conversation.ts";
import { __resetThreadWriteLocksForTest } from "./hooks/thread_write.ts";
import { dispatchKey, reachableKeys, resolveKeybind, type KeyLike } from "./keymap.ts";
import type { Analysis } from "../types/analysis.ts";

// The keymap dispatches the FIRST full match of a chord, and `reachableKeys`
// dedupes on stroke plus desc. Thus two bindings on one chord ship silently:
// the which-key panel lists both, and only one can ever fire. This mounts the
// real `App` — the real binding table — arms the leader, and requires each
// reachable stroke to be unique. A collision anywhere in the app layer fails
// here by name, not in a user's terminal.

let dir = "";
let analysis: Analysis;

function key(name: string, mods: Partial<Pick<KeyLike, "ctrl" | "meta" | "option" | "shift">> = {}): KeyLike & { preventDefault: () => void } {
    return { name, ctrl: false, meta: false, option: false, shift: false, ...mods, preventDefault: () => {} };
}

beforeEach(async () => {
    freshDb();
    dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-chords-")));
    analysis = (await createAnalysis({ cwd: dir, name: str256("chord-test")._unsafeUnwrap(), inputPaths: [] }))._unsafeUnwrap();
    // `ready` opens every gated layer, thus the sweep sees the full table.
    __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
    __setAgentModelsForTest({ current: { conversation: "m", sandbox: "m", utility: "m" }, pending: new Map() });
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    dialogClear();
    resetHotState();
    __resetSidebarLiveForTest();
    __resetActivityPanelForTest();
    __resetRunCompletionsForTest();
    __resetNoticesForTest();
    __resetThreadWriteLocksForTest();
    __setBootStateForTest({ phase: "idle" });
});

describe("the chord table of App", () => {
    test("each stroke reachable from the leader is unique", async () => {
        const setup = await testRender(() => <App workingDir={dir} analysis={analysis} />, { width: 100, height: 26 });
        try {
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
        } finally {
            dispatchKey(key("escape"));
            setup.renderer.destroy();
        }
    });
});
