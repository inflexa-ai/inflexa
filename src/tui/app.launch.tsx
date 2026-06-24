import { render } from "@opentui/solid";
import { ConsolePosition } from "@opentui/core";

import { warmGrammars } from "./grammars/register.ts";
import { ensureProxyReadyOrExit } from "../modules/proxy/setup.ts";
import { resolveNewTarget, resolveResumeTarget, resolveDefaultTarget, type ChatTarget } from "../modules/analysis/launch.ts";
import type { ContextFlags } from "../modules/analysis/context.ts";
import { readConfig } from "../lib/config.ts";
import type { IdOrName } from "../lib/types.ts";
import { App } from "./app.tsx";
import { setTheme } from "./theme.ts";

// The TUI-entry layer: a thin render shim. All resolution/prompting/creation logic lives in
// modules/analysis/launch.ts (headless, returns a ChatTarget); this file only makes the proxy
// ready and hands the terminal to the opentui renderer. It lives in tui/ because tui/ may import
// module logic (view → logic) where a module may never import tui/ — so the render() call, the
// one thing that truly belongs to presentation, is isolated here. The proxy-ready check runs in
// the normal-stdio phase, BEFORE render() takes over the terminal.

/**
 * Make the proxy ready (its auth flow needs normal stdio), seed the active theme from persisted
 * config, then hand the terminal to OpenTUI to open the chat for the resolved target.
 */
async function renderChat(target: ChatTarget): Promise<void> {
    await ensureProxyReadyOrExit();

    setTheme(readConfig().theme);
    void render(() => <App sessionId={target.sessionId} workingDir={target.workingDir} analysis={target.analysis} />, {
        exitOnCtrlC: false,
        // 60fps so the smooth streamed-text reveal (conversation.ts) repaints finely; the renderer is
        // on-demand, so an idle chat still costs no frames. Matches the opencode TUI cadence.
        targetFps: 60,
        screenMode: "alternate-screen",
        consoleOptions: {
            position: ConsolePosition.BOTTOM,
            maxStoredLogs: 500,
            sizePercent: 30,
        },
    });

    // Register + warm the markdown/code tree-sitter grammars (see warmGrammars). Fire-and-forget AFTER
    // render() takes over the terminal: in a `bun --compile` binary the worker isn't embedded and logs
    // an error — running this post-render keeps that log inside the TUI console overlay instead of over
    // the launch/picker output, and warmGrammars swallows the failure so it never breaks startup.
    void warmGrammars();
}

/** `inf new [name] [paths...]` — create an analysis (anchor = cwd) and open its chat. */
export async function launchNew(opts: { name?: string; paths: string[]; project?: string; output?: string }): Promise<void> {
    await renderChat(await resolveNewTarget(opts));
}

/** `inf resume <id|name>` — reopen an analysis's chat. */
export async function launchResume(ref: IdOrName): Promise<void> {
    await renderChat(resolveResumeTarget(ref));
}

/** Bare `inf [--analysis <x>|--project <p>]`: resolve context, then open/pick/start (or do nothing). */
export async function launchDefault(flags: ContextFlags): Promise<void> {
    const target = await resolveDefaultTarget(flags);
    if (target) await renderChat(target);
}
