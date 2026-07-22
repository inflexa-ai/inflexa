import { GLYPHS } from "./design_system.ts";
import { flushLogs } from "./log.ts";
import { shutdownOtel } from "./otel.ts";

let shuttingDown = false;

/**
 * Grace period before the exit indicator's first frame. An idle runtime drains in single-digit
 * milliseconds, and a spinner that appears for one frame reads as a rendering glitch rather than
 * progress — only a drain that outlives this window is worth narrating.
 */
const INDICATOR_DELAY_MS = 500;

/** Frame cadence — fast enough to read as continuous motion, slow enough to cost nothing. */
const INDICATOR_FRAME_MS = 80;

/**
 * Elapsed time after which the indicator stops merely spinning and explains itself. A drain this long
 * means the harness is waiting on in-flight durable work, whose duration is the work's, not the
 * process's — the reader needs to know the wait is expected rather than a hang they should kill.
 */
const INDICATOR_EXPLAIN_AFTER_MS = 5_000;

/**
 * Narrate a slow exit, returning a stop function that erases what it drew.
 *
 * Writes to stderr, and only to a TTY: {@link shutdown} runs on EVERY exit path, including piped text
 * commands whose stdout is a machine-readable payload, so the indicator must have no way to reach that
 * stream. The cursor is deliberately NOT hidden — a second SIGTERM force-exits past the stop function
 * (`src/index.ts`), and a hidden cursor would survive into the user's shell.
 *
 * Callers that own the terminal must restore it first: the TUI's `quit()` calls `renderer.destroy()`
 * before `shutdown()`, so by the time this draws, the alternate screen is gone and stderr is the
 * normal scrollback again.
 */
export function startExitIndicator(): () => void {
    if (!process.stderr.isTTY) return () => {};

    const startedAt = Date.now();
    let frame = 0;
    const timer = setInterval(() => {
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs < INDICATOR_DELAY_MS) return;
        // `frame % length` is in range by construction, which `noUncheckedIndexedAccess` cannot see.
        const glyph = GLYPHS.spinner[frame++ % GLYPHS.spinner.length]!;
        const message = elapsedMs < INDICATOR_EXPLAIN_AFTER_MS ? "Exiting…" : "Exiting — waiting for in-flight work to finish, this can take a while";
        // `\r\x1b[2K` returns to column 0 and clears the row, so each frame overwrites the last
        // in place instead of scrolling a new line per tick.
        process.stderr.write(`\r\x1b[2K${glyph} ${message} (${Math.round(elapsedMs / 1000)}s)`);
    }, INDICATOR_FRAME_MS);
    // The indicator must never be the reason the process stays alive: `beforeExit` reaches
    // `shutdown()` precisely when nothing else is pending, and a ref'd timer would re-arm the loop.
    timer.unref();

    return () => {
        clearInterval(timer);
        // Erase only what was drawn. Below the delay the indicator never wrote, and clearing the row
        // would wipe whatever the command legitimately left on the last line.
        if (Date.now() - startedAt >= INDICATOR_DELAY_MS) process.stderr.write("\r\x1b[2K");
    };
}

/** Async cleanup hooks registered by modules (e.g. provenance flush). Runs alongside log/telemetry flush. */
const asyncHooks: (() => Promise<void>)[] = [];

/** Register an async cleanup function to run during shutdown — keeps the dependency direction correct (module → lib, never lib → module). */
export function onShutdown(hook: () => Promise<void>): void {
    asyncHooks.push(hook);
}

/**
 * Flush logs and telemetry, then exit. The CLI is short-lived — without this,
 * the final batch of records is silently dropped on `process.exit()`.
 *
 * The drain is not always instant: the harness hook waits for DBOS to settle its in-flight workflows,
 * which can take as long as the work does. {@link startExitIndicator} covers that window so a slow
 * exit reads as progress rather than a dead prompt.
 */
export async function shutdown(code: number): Promise<never> {
    if (!shuttingDown) {
        shuttingDown = true;
        const stopIndicator = startExitIndicator();
        try {
            await Promise.allSettled([...asyncHooks.map((h) => h()), flushLogs(), shutdownOtel()]);
        } finally {
            // `allSettled` never rejects, but a hook that throws SYNCHRONOUSLY throws out of the
            // `map` before the array exists — the indicator must be torn down on that path too, or a
            // failed exit leaves a half-drawn frame in the shell.
            stopIndicator();
        }
    }
    process.exit(code);
}
