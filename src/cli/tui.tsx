import { render } from "@opentui/solid";
import { ConsolePosition } from "@opentui/core";

import { getSession } from "../db/primary_query.ts";
import { createSession } from "../db/primary_mutation.ts";
import { App } from "../tui/app.tsx";
import type { Session } from "../types.ts";

interface TuiOptions {
    session?: string;
}

export async function launchTui(opts: TuiOptions) {
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
