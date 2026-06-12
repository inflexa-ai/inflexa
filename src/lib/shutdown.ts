import { flushLogs } from "./log.ts";
import { shutdownOtel } from "./otel.ts";

let shuttingDown = false;

/**
 * Flush logs and telemetry, then exit. The CLI is short-lived — without this,
 * the final batch of records is silently dropped on `process.exit()`.
 */
export async function shutdown(code: number): Promise<never> {
    if (!shuttingDown) {
        shuttingDown = true;
        await Promise.allSettled([flushLogs(), shutdownOtel()]);
    }
    process.exit(code);
}
