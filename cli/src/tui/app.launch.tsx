import { render } from "@opentui/solid";
import { ConsolePosition } from "@opentui/core";

import { warmGrammars } from "./grammars/register.ts";
import { resolveNewTarget, resolveResumeTarget, resolveDefaultTarget, type ChatTarget, type ContextFlags } from "../client/commands/analyses.ts";
import { setClientSurface } from "../client/api.ts";
import { requireInteractiveTerminal } from "../lib/cli.ts";
import { readConfig } from "../lib/config.ts";
import type { IdOrName } from "../lib/types.ts";
import { watchServerBoot } from "./hooks/boot.ts";
import { notify } from "./hooks/notice.ts";
import { ConfirmDialog } from "./components/dialog/confirm_dialog.tsx";
import { dialogClose, dialogPush } from "./components/dialog/dialog_host.tsx";
import { App } from "./app.tsx";
import { setTheme } from "./theme.ts";
import pkg from "../../package.json";
import { applyErrorMessage, applyUpdate } from "../modules/update/apply.ts";
import { installChannel } from "../modules/update/channel.ts";
import { pendingUpdate } from "../modules/update/latest.ts";
import { claimDailyAsk, claimUpdateNotice, updateOffer } from "../modules/update/notice.ts";

// The TUI-entry layer: a thin render shim. All resolution/prompting/creation logic lives in
// client/commands/analyses.ts (a client of the server, returns a ChatTarget); this file only hands the terminal to the
// opentui renderer. The local server owns the harness runtime and its prerequisites (the proxy, the
// containers, the harness config): the TUI is one of its clients, and it reads the boot phase of the
// server after render().

/**
 * Seed the active theme from persisted config, then hand the terminal to OpenTUI to open the chat for the
 * resolved target.
 */
async function renderChat(target: ChatTarget): Promise<void> {
    // The server took the instance lock of the analysis when the resolver opened it (`GET {A}`), before
    // the alternate screen, thus a lock that a different process holds already stopped the launch.
    setTheme(readConfig().theme);
    setClientSurface("chat");

    // Claimed BEFORE the screen is taken. This launcher returns as soon as the renderer has the terminal,
    // so the command beneath it finishes while the chat is live, and the stderr report would paint over it.
    // The dialog below is this surface's own form of the same message.
    claimUpdateNotice();

    void render(() => <App workingDir={target.workingDir} analysis={target.analysis} />, {
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

    // Offer the newest release, behind the same post-render fire-and-forget discipline as the two calls
    // above. The read goes to the network on each launch, with a short cap (modules/update/latest.ts);
    // the dialog stack is module state, so a push that lands before the overlay mounts still renders
    // once it does.
    void offerUpdate();

    // Read the boot phase of the server AFTER render() has the terminal (fire-and-forget, the same
    // territory as warmGrammars): the server can still be booting (Postgres, DBOS, the composition root),
    // so the read runs behind the boot animation with the input gated — hooks/boot.ts drives the
    // boot-state store the App reads.
    void watchServerBoot();
}

/**
 * Ask whether to install the newest release, in the one place the CLI has a person in front of it.
 *
 * A subcommand gets a REPORT instead (modules/update/notice.ts), because its caller can be a script or an
 * agent and neither can answer a question. The TUI is the surface that can hold an answer, so the question
 * lives here — the shape codex arrived at.
 *
 * A channel whose package manager owns the binary gets a toast naming that manager's command, never a
 * dialog: a dialog whose only outcome is a line of text to copy is a question with no answer in it.
 */
async function offerUpdate(): Promise<void> {
    const offer = updateOffer(await pendingUpdate(), installChannel());
    if (offer.kind === "none") return;
    if (offer.kind === "tell") {
        notify({ kind: "info", text: `inflexa ${offer.version} is out. Update with: ${offer.instruction}` }, 8000, { queue: true });
        return;
    }

    // One ask a day: the read above runs at each startup, and this claim is what keeps the dialog from
    // opening on each launch. The toast above is not under the record, because a toast does not
    // interrupt.
    if (!claimDailyAsk(offer.version)) return;

    const version = offer.version;
    dialogPush(() => (
        <ConfirmDialog
            title="A new inflexa is out"
            // Says WHEN it takes effect, because the swap is invisible to the running process: the open
            // session keeps the old binary, and a user who is not told that reads the unchanged version in
            // the status bar as a failed update.
            message={`Version ${version} is available, and this is ${pkg.version}. Install it now? It takes effect the next time you start inflexa.`}
            // Unlike a delete, the safe answer here is yes: the download is verified against the release
            // checksum, and nothing of the user's is at risk either way.
            defaultActive="confirm"
            cancelLabel="not now"
            onConfirm={() => {
                dialogClose();
                void installUpdate(version);
            }}
            onCancel={() => dialogClose("cancel")}
        />
    ));
}

/**
 * Download and install `version`, narrating through the toast channel.
 *
 * Queued notices, not a progress bar: the install runs behind a live chat the user did not stop doing, so
 * it must report without taking the screen. A failure names what to do, because the alternative — a silent
 * failure — leaves the next start still on the old version with no reason given.
 */
async function installUpdate(version: string): Promise<void> {
    notify({ kind: "info", text: `Downloading inflexa ${version}.` }, 6000, { queue: true });
    (await applyUpdate(version)).match(
        () => notify({ kind: "info", text: `inflexa ${version} is installed. Restart inflexa to use it.` }, 8000, { queue: true }),
        (error) => notify({ kind: "error", text: applyErrorMessage(error) }, 10000, { queue: true }),
    );
}

/** `inflexa new [name] [paths...]` — create an analysis (anchor = cwd) and open its chat. */
export async function launchNew(opts: { name?: string; paths: string[]; project?: string }): Promise<void> {
    // Before target resolution, not inside renderChat: resolveNewTarget CREATES the
    // analysis, and a headless run must refuse before any state exists (no-litter).
    requireInteractiveTerminal("inflexa new");
    await renderChat(await resolveNewTarget(opts));
}

/** `inflexa resume <id|name>` — reopen an analysis's chat. */
export async function launchResume(ref: IdOrName): Promise<void> {
    requireInteractiveTerminal("inflexa resume");
    await renderChat(await resolveResumeTarget(ref));
}

/** Bare `inflexa [--analysis <x>|--project <p>]`: resolve context, then open/pick/start (or do nothing). */
export async function launchDefault(flags: ContextFlags): Promise<void> {
    requireInteractiveTerminal("inflexa");
    const target = await resolveDefaultTarget(flags);
    if (target) await renderChat(target);
}
