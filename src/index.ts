// Side-effect import: installs the global runtime extensions before any command runs.
import "./extensions/index.ts";

import { CommanderError } from "commander";

import { cli } from "./cli/index.ts";
import { initBusLogging } from "./lib/bus.ts";
import { readConfig } from "./lib/config.ts";
import { addLogStream, flushLogsSync, getLogger } from "./lib/log.ts";
import { createOtelLogStream, initOtel } from "./lib/otel.ts";
import { shutdown } from "./lib/shutdown.ts";

if (initOtel(readConfig().telemetry)) {
    addLogStream(createOtelLogStream());
}
initBusLogging();

// Commands that exit by event-loop drain (sessions, telemetry) never call
// shutdown() themselves; beforeExit catches them. It does not fire on the
// TUI's explicit shutdown()/process.exit() path.
process.on("beforeExit", () => {
    void shutdown(typeof process.exitCode === "number" ? process.exitCode : 0);
});
process.on("exit", flushLogsSync);

getLogger("main").info({ argv: process.argv.slice(2) }, "cli start");

try {
    await cli.parseAsync();
} catch (error) {
    // exitOverride (src/cli/index.ts) makes Commander throw instead of calling
    // process.exit() for help/version/parse errors. --help/--version are not
    // failures (exitCode 0); a real parse error carries a non-zero code. Either
    // way, record the code and fall through: beforeExit -> shutdown() then
    // flushes logs/telemetry and exits cleanly. Anything else is a genuine fault
    // — rethrow it.
    if (error instanceof CommanderError) {
        // The most common cause of excess arguments is an unquoted option value
        // containing spaces: the shell splits it into separate words, only the
        // first binds to the flag, and the rest land as stray positionals (e.g.
        // `--description Test project` -> `Test` is the value, `project` a leftover
        // argument). Commander's message can't know that, so add the actionable fix.
        if (error.code === "commander.excessArguments") {
            console.error('\nHint: quote option values that contain spaces, e.g. --description "Test project".');
        }
        if (error.exitCode !== 0) process.exitCode = error.exitCode;
    } else {
        // A genuine fault, not Commander's help/version/parse-error signal.
        // Record and surface it, then drain via shutdown(): a bare rethrow exits
        // through the exception path, which skips beforeExit -> shutdown() and
        // drops the final log/telemetry batch. shutdown() is idempotent.
        getLogger("main").error({ err: error }, "cli failed");
        console.error(error);
        await shutdown(1);
    }
}
