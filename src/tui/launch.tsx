import { render } from "@opentui/solid";
import { ConsolePosition } from "@opentui/core";

import { getSession } from "../db/primary_query.ts";
import { createSession } from "../db/primary_mutation.ts";
import { ensureProxyReady, ProxyError } from "../modules/proxy/setup.ts";
import { recoverAnchors } from "../modules/anchor/anchor.ts";
import { readConfig } from "../lib/config.ts";
import { getLogger } from "../lib/log.ts";
import { App } from "./app.tsx";
import { setTheme } from "./theme.ts";
import type { Session } from "../types/session.ts";

type TuiOptions = {
    session?: string;
};

export async function launchTui(opts: TuiOptions) {
    // The TUI can only operate against a running, authenticated CLIProxyAPI.
    // Make it ready (auto-start the container, sign in if needed) before the
    // renderer takes over the terminal — the auth flow needs normal stdio.
    try {
        await ensureProxyReady();
    } catch (error) {
        if (error instanceof ProxyError) {
            console.error(`\n  ${error.message}\n`);
        } else {
            console.error("\n  Could not start CLIProxyAPI:", error, "\n");
        }
        process.exit(1);
    }

    const workingDir = process.cwd();

    // Automatic anchor recovery: heal anchors whose folders moved since last run so a
    // resumed session resolves to the live path. The automatic counterpart to the manual
    // repair/relocate/prune backstop. Results go to the log, not the screen: the renderer
    // is about to take over the terminal.
    //
    // INTENTIONAL — recovery only, NEVER creation. Launching the TUI must not write a
    // `.inf/id` marker into the cwd (no-litter policy): minting an anchor is reserved for a
    // deliberate user action, not a passive flow like opening the app. Do NOT "fix" this by
    // swapping in getOrCreateAnchorForCwd — that side effect is the bug, not the feature.
    const log = getLogger("anchor");
    recoverAnchors([workingDir]).match(
        ({ recovered, unresolved }) => {
            if (recovered || unresolved) log.info({ recovered, unresolved }, "recovered anchors at startup");
        },
        (error) => log.warn({ err: error }, "anchor recovery failed"),
    );

    let session: Session | null = null;

    if (opts.session) {
        session = getSession(opts.session).match(
            (s) => s,
            (error) => {
                console.error(`Failed to load session: ${error.type}`, error.cause);
                process.exit(1);
            },
        );
    }

    if (!session) {
        session = createSession(`Session in ${workingDir.split("/").pop()}`).match(
            (s) => s,
            (error) => {
                console.error(`Failed to create session: ${error.type}`, error.cause);
                process.exit(1);
            },
        );
    }

    // Seed the active theme from persisted config before the renderer reads it.
    setTheme(readConfig().theme);

    void render(() => <App sessionId={session!.id} workingDir={workingDir} />, {
        exitOnCtrlC: false,
        targetFps: 30,
        screenMode: "alternate-screen",
        consoleOptions: {
            position: ConsolePosition.BOTTOM,
            maxStoredLogs: 500,
            sizePercent: 30,
        },
    });
}
