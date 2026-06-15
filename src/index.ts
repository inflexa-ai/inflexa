// Side-effect import: installs the global runtime extensions before any command runs.
import "./extensions/index.ts";

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

cli.parse();
