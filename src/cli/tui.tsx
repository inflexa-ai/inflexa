import { render } from "@opentui/solid";
import { ConsolePosition } from "@opentui/core";

import { getSession } from "../db/primary_query.ts";
import { createSession } from "../db/primary_mutation.ts";
import { App } from "../tui/app.tsx";

interface TuiOptions {
    session?: string;
}

export async function launchTui(opts: TuiOptions) {
    const workingDir = process.cwd();

    let session = opts.session ? getSession(opts.session) : null;
    if (!session) {
        session = createSession(`Session in ${workingDir.split("/").pop()}`);
    }

    render(() => <App sessionId={session!.id} workingDir={workingDir} />, {
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
