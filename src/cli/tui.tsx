import { render } from "@opentui/solid";
import { ConsolePosition } from "@opentui/core";

import * as store from "../db/store.ts";
import { App } from "../tui/app.tsx";

interface TuiOptions {
    session?: string;
}

export async function launchTui(opts: TuiOptions) {
    const workingDir = process.cwd();

    let session = opts.session ? store.getSession(opts.session) : null;
    if (!session) {
        session = store.createSession(`Session in ${workingDir.split("/").pop()}`);
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
