import { render } from "@opentui/solid";
import { ConsolePosition } from "@opentui/core";

import { warmGrammars } from "./grammars/register.ts";
import { ensureProxyReadyOrExit } from "../modules/infra/setup.ts";
import { resolveNewTarget, resolveResumeTarget, resolveDefaultTarget, type ChatTarget } from "../modules/analysis/launch.ts";
import { acquireInstanceLock } from "../lib/lock.ts";
import { fail, requireInteractiveTerminal } from "../lib/cli.ts";
import type { ContextFlags } from "../modules/analysis/context.ts";
import { readConfig } from "../lib/config.ts";
import { shutdown } from "../lib/shutdown.ts";
import type { IdOrName } from "../lib/types.ts";
import { resolveHarnessConfig, resolveModelConnection } from "../modules/harness/config.ts";
import { describeBootError } from "../modules/harness/runtime.ts";
import { ensureSandboxImage } from "../modules/libs/pull.ts";
import { startHarnessBoot } from "./hooks/boot.ts";
import { notify } from "./hooks/notice.ts";
import { ConfirmDialog } from "./components/dialog/confirm_dialog.tsx";
import { dialogClose, dialogPush } from "./components/dialog/dialog_host.tsx";
import { App } from "./app.tsx";
import { setTheme } from "./theme.ts";
import pkg from "../../package.json";
import { applyErrorMessage, applyUpdate } from "../modules/update/apply.ts";
import { installChannel } from "../modules/update/channel.ts";
import { pendingUpdate } from "../modules/update/latest.ts";
import { claimUpdateNotice, updateOffer } from "../modules/update/notice.ts";

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
    // Resolve the chat backend connection first: its mode decides whether the proxy gate runs at all
    // (a direct connection skips proxy config/auth — see ensureProxyReady), and a malformed
    // `models.connection` block must surface as its real problem here, not as a misleading proxy-auth
    // failure from running the cliproxy gate against the fail-closed default.
    const connection = resolveModelConnection();
    if (connection.configError) fail(describeBootError({ type: "model_connection_invalid", issues: connection.configError.issues }));
    await ensureProxyReadyOrExit(connection.mode);

    // Harness pre-flight gates that need normal stdio — resolved once here and reused by the
    // post-render boot below, so the model/image/policy are computed a single time. The config gate
    // mirrors `inflexa profile`: a bad `harness` field must surface as its real problem, not a
    // misleading downstream boot error (resolveHarnessConfig collapses every field to a default on a
    // config error, so a later image check would inspect the wrong tag). `ensureSandboxImage` is
    // INTERACTIVE (confirm/pull a multi-GB image), so its prompt has to run on normal stdio, before
    // render() takes the terminal — never inside the alternate screen.
    const cfg = resolveHarnessConfig();
    if (cfg.configError) fail(describeBootError({ type: "harness_config_invalid", issues: cfg.configError.issues }));
    await ensureSandboxImage(cfg.sandboxImage);

    // Claim the analysis before the alternate screen takes over, so a conflict surfaces as a plain
    // stderr line and a clean exit — no flash of TUI. Acquiring here (not in the headless resolvers)
    // keeps the lock off the bare-`inflexa`-resolves-to-nothing path: that path returns null and never
    // reaches renderChat, so it writes no lock (no-litter policy).
    const lock = acquireInstanceLock(target.analysis.id);
    if (!lock.acquired) {
        console.error(`"${target.analysis.name}" is already open in another instance. Open or resume a different analysis.`);
        await shutdown(1);
    }

    setTheme(readConfig().theme);

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
    // above. It reads from a recorded answer on all but one run a day, so it usually settles before the
    // first frame; the dialog stack is module state, so a push that lands before the overlay mounts still
    // renders once it does.
    void offerUpdate();

    // Boot the embedded harness runtime AFTER render() has the terminal (fire-and-forget, the same
    // territory as warmGrammars): boot is the longest phase (Postgres, DBOS, the composition root),
    // so it runs async behind the boot animation with the input gated — hooks/boot.ts drives the
    // boot-state store the App reads. Reached ONLY from renderChat: the passive
    // bare-`inflexa`-resolves-to-nothing path returns before renderChat and boots nothing (no-litter).
    void startHarnessBoot(cfg);
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
    await renderChat(resolveResumeTarget(ref));
}

/** Bare `inflexa [--analysis <x>|--project <p>]`: resolve context, then open/pick/start (or do nothing). */
export async function launchDefault(flags: ContextFlags): Promise<void> {
    requireInteractiveTerminal("inflexa");
    const target = await resolveDefaultTarget(flags);
    if (target) await renderChat(target);
}
