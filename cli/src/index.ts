// Side-effect import: installs the global runtime extensions before any command runs.
import "./extensions/index.ts";

import { CommanderError } from "commander";

import { cli } from "./cli/index.ts";
import { releaseHeldAnalysisLock } from "./modules/analysis/lock.ts";
import { initProvenanceRecording, flushProvenanceAsync } from "./modules/prov/prov.ts";
import { initBusLogging } from "./lib/bus.ts";
import { readConfig } from "./lib/config.ts";
import { addLogStream, flushLogsSync, getLogger } from "./lib/log.ts";
import { createOtelLogStream, initOtel } from "./lib/otel.ts";
import { onShutdown, shutdown } from "./lib/shutdown.ts";

if (initOtel(readConfig().telemetry)) {
    addLogStream(createOtelLogStream());
}
initBusLogging();
// Subscribe the provenance recorder before any command can emit a `prov.*` event (createAnalysis
// runs before the TUI opens). The eager import pulls tsprov into startup for every command — accepted
// as the simple, correct choice now that the package builds; lazy-load the recorder if that cost bites.
initProvenanceRecording();
// Flush un-persisted provenance (with signing) during shutdown — registered as a hook so the
// dependency direction stays correct (module → lib, never lib → module).
onShutdown(flushProvenanceAsync);

// Commands that exit by event-loop drain (sessions, telemetry) never call
// shutdown() themselves; beforeExit catches them. It does not fire on the
// TUI's explicit shutdown()/process.exit() path.
process.on("beforeExit", (exitCode) => {
    void shutdown(exitCode);
});
process.on("exit", flushLogsSync);
// Release this instance's analysis lock on any exit. This single sync hook covers the graceful TUI
// quit too (App.quit → shutdown → process.exit), so no separate release in App.quit() is needed.
// SIGKILL bypasses it; that stale lock is reclaimed by the pid check on the next open.
process.on("exit", releaseHeldAnalysisLock);

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
