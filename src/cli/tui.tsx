import { render } from "@opentui/solid";
import { ConsolePosition } from "@opentui/core";

import { getSession } from "../db/primary_query.ts";
import { createSession } from "../db/primary_mutation.ts";
import { ensureProxyReady, ProxyError } from "./setup.ts";
import { readConfig } from "../lib/config.ts";
import { App } from "../tui/app.tsx";
import { setTheme } from "../tui/theme.ts";
import type { Session } from "../types.ts";

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
