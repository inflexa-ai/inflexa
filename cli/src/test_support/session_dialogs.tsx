import { afterEach } from "bun:test";
import { okAsync } from "neverthrow";
import { testRender } from "@opentui/solid";

import { dialogClear, dialogPush } from "../tui/components/dialog/dialog_host.tsx";
import type { SessionOpts } from "../tui/commands.tsx";
import type { Workspace } from "../tui/contexts/workspace.ts";
import { __resetBootForTest, __setBootStateForTest } from "../tui/hooks/boot.ts";
import { __resetKeybindCache } from "../tui/keymap.ts";
import type { Notice } from "../tui/theme.ts";
import type { Analysis } from "../types/analysis.ts";
import { buildAnalysis, buildWorkspace } from "./builders.ts";
import { dialogHostNode } from "./dialog_harness.tsx";
import { sessionOptsDouble } from "./session_doubles.ts";
import { conversationSummary } from "./threads.ts";

/** The open scope a session-dialog case mounts, plus the dialogs the flow may close on its own. */
export type SessionDialogScope = {
    readonly analysis: Analysis;
    readonly sessionId: string;
    readonly closeDialog?: Workspace["closeDialog"];
};

/** What the drive callback gets: the mounted workspace and the notices the flow raised. */
export type SessionDialogDrive = {
    readonly ws: Workspace;
    readonly notices: Notice[];
};

/** The live harness of a mounted session dialog: the render setup, the workspace, and the notices. */
export type SessionDialogHarness = {
    readonly setup: Awaited<ReturnType<typeof testRender>>;
    readonly ws: Workspace;
    readonly notices: Notice[];
};

/**
 * Mount the production dialog host under a keymap root and the given scope, set the boot phase the
 * flows gate on, drive one session flow through the REAL host, and settle one frame. `openDialog` is
 * wired to `dialogPush` — the capability App wires — so the dialog under assertion is the one
 * production pushes, not a hand-built stand-in that could drift from it.
 */
export async function mountSessionDialog(scope: SessionDialogScope, drive: (h: SessionDialogDrive) => unknown): Promise<SessionDialogHarness> {
    const notices: Notice[] = [];
    const workspaceOverrides: Partial<Workspace> = {
        analysis: scope.analysis,
        sessionId: scope.sessionId,
        openDialog: dialogPush,
    };
    if (scope.closeDialog) workspaceOverrides.closeDialog = scope.closeDialog;
    const ws = buildWorkspace(workspaceOverrides);
    const setup = await testRender(dialogHostNode(ws), { width: 90, height: 30 });
    __setBootStateForTest({ phase: "ready", model: "claude-test", connection: { provider: "anthropic", mode: "cliproxy" } });
    await drive({ ws, notices });
    await Promise.resolve();
    await setup.renderOnce();
    return { setup, ws, notices };
}

/**
 * Mount, act, and ALWAYS destroy the renderer. An undisposed renderer outlives its test and corrupts
 * every later render suite in the same process (opentui installs process-level handlers per
 * renderer), so disposal is not tidiness here — it is what keeps a file from failing other files.
 */
export async function withSessionDialog<T>(
    scope: SessionDialogScope,
    drive: (h: SessionDialogDrive) => unknown,
    act: (h: SessionDialogHarness) => Promise<T> | T,
): Promise<T> {
    const harness = await mountSessionDialog(scope, drive);
    try {
        return await act(harness);
    } finally {
        harness.setup.renderer.destroy();
    }
}

/**
 * Mount, drive one flow, capture the settled frame, assert against it, and always destroy — the
 * shape of a session-dialog case that only reads what the dialog SAYS.
 */
export async function sessionDialogFrame(scope: SessionDialogScope, drive: (h: SessionDialogDrive) => unknown, assert: (frame: string) => void): Promise<void> {
    await withSessionDialog(scope, drive, ({ setup }) => {
        assert(setup.captureCharFrame());
    });
}

/**
 * The world both destructive-confirmation dialogs test in: one LIVE conversation row — the flows only
 * ever confirm against a live row — the server options that answer it, and the scope that opens it.
 * The call registers the after-each reset of the keymap, boot, and dialog state a mounted flow leaves
 * behind, so a caller needs no cleanup of its own.
 */
export function liveThreadConfirmWorld(): {
    readonly scope: SessionDialogScope;
    readonly opts: SessionOpts;
} {
    afterEach(() => {
        __resetKeybindCache();
        __resetBootForTest();
        dialogClear();
    });
    const analysis = buildAnalysis();
    const thread = conversationSummary({ id: "thread-1", resourceId: analysis.id });
    const opts = sessionOptsDouble({
        getThread: () => okAsync(thread),
        resolveThreadId: () => Promise.resolve("thread-2"),
    }).opts;
    return { scope: { analysis, sessionId: "thread-1" }, opts };
}
