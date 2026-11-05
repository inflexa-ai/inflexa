import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dialogClear } from "../tui/components/dialog/dialog_host.tsx";
import { resetHotState } from "../tui/hooks/conversation.ts";
import { __resetActivityPanelForTest } from "../tui/hooks/activity_panel.ts";
import { __setAgentModelsForTest, __setBootStateForTest } from "../tui/hooks/boot.ts";
import { __resetNoticesForTest } from "../tui/hooks/notice.ts";
import { __resetRunCompletionsForTest } from "../tui/hooks/run_completion.ts";
import { __resetSidebarLiveForTest } from "../tui/hooks/sidebar_live.ts";

/** The scratch directory of the CURRENT test, unique per test and removed by the cleanup. */
export type AppRenderScope = {
    readonly dir: () => string;
};

/**
 * The before/after lifecycle every rendered-`App` test needs: a fresh working directory, the boot
 * phase set `ready` — which opens the input gate and every gated layer, so the sweep and the panel
 * see the full table — and the agent models the panel reads. Then the full reset, because each of
 * these stores and singletons survives a test otherwise: boot state and the notice channel are
 * module singletons, and a leaked one corrupts the next test's frames and assertions.
 */
export function appRenderLifecycle(dirPrefix: string): AppRenderScope {
    let dir = "";
    beforeEach(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), dirPrefix)));
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
    return { dir: () => dir };
}
