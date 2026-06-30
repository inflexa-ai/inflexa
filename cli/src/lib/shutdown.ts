import { flushLogs } from "./log.ts";
import { shutdownOtel } from "./otel.ts";

let shuttingDown = false;

/** Async cleanup hooks registered by modules (e.g. provenance flush). Runs alongside log/telemetry flush. */
const asyncHooks: (() => Promise<void>)[] = [];

/** Register an async cleanup function to run during shutdown — keeps the dependency direction correct (module → lib, never lib → module). */
export function onShutdown(hook: () => Promise<void>): void {
    asyncHooks.push(hook);
}

/**
 * Flush logs and telemetry, then exit. The CLI is short-lived — without this,
 * the final batch of records is silently dropped on `process.exit()`.
 */
export async function shutdown(code: number): Promise<never> {
    if (!shuttingDown) {
        shuttingDown = true;
        await Promise.allSettled([...asyncHooks.map((h) => h()), flushLogs(), shutdownOtel()]);
    }
    process.exit(code);
}
