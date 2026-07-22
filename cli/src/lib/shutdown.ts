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

/** Assumed row width when stderr reports none — the conventional terminal default. */
const INDICATOR_FALLBACK_COLUMNS = 80;

const INDICATOR_MESSAGE = "Exiting…";
const INDICATOR_EXPLAIN_MESSAGE = "Exiting — waiting for in-flight work to finish, this can take a while";
/**
 * The explanation, shortened to clear a conventional 80-column row once the glyph and a two-unit age
 * are added. Without this rung the full message — 80 columns exactly — would lose to the fit check on
 * the most common terminal width there is, and the reader would get the bare `Exiting…` precisely
 * during the long waits the explanation exists for.
 */
const INDICATOR_EXPLAIN_BRIEF = "Exiting — waiting for in-flight work to finish";

/**
 * Compose one frame, widest variant that fits the row.
 *
 * Fitting is not cosmetic. `\r\x1b[2K` erases only the row the cursor is on, so a frame that WRAPS
 * leaves its first row stranded and the next tick redraws below it — the indicator smears down the
 * screen instead of animating in place. The explain variant is 80 columns with a two-unit age, i.e.
 * it wraps on the conventional default width, so this is the common case rather than a narrow-pane
 * edge case.
 *
 * Degrading through variants rather than truncating the full line keeps the age visible: the age is
 * what distinguishes a live drain from a wedged one, and it sits at the END of the line, so a plain
 * truncation would cut off precisely the part worth reading. The final fallback is the bare glyph,
 * which still animates.
 *
 * One column is left spare because writing into the last one puts most terminals into a deferred-wrap
 * state that the following `\r` resolves inconsistently.
 */
export function exitIndicatorFrame(glyph: string, startedAt: number, columns: number): string {
    const age = Date.relativeAge(startedAt);
    const explaining = Date.now() - startedAt >= INDICATOR_EXPLAIN_AFTER_MS;
    const budget = Math.max(0, columns - 1);
    const variants = [
        ...(explaining ? [`${glyph} ${INDICATOR_EXPLAIN_MESSAGE} (${age})`, `${glyph} ${INDICATOR_EXPLAIN_BRIEF} (${age})`] : []),
        `${glyph} ${INDICATOR_MESSAGE} (${age})`,
        `${glyph} ${INDICATOR_MESSAGE}`,
        glyph,
    ];
    return variants.find((variant) => variant.length <= budget) ?? glyph.slice(0, budget);
}

/**
 * Write one frame, swallowing any failure.
 *
 * The indicator is decoration on the last code path the process ever runs, so it must not be able to
 * turn a clean exit into a crash — and both of its failure modes are reachable. `process.stderr.write`
 * throws `EPIPE` when the terminal goes away mid-drain, which is precisely the SIGHUP case
 * `src/index.ts` routes here; and {@link exitIndicatorFrame} reads `Date.relativeAge`, a runtime
 * extension installed by the entry point rather than by this module. A throw from either would escape
 * the `setInterval` callback uncaught, killing the process before {@link shutdown} reaches
 * `process.exit` and burying whatever the real exit code was meant to be.
 *
 * Losing the animation is the correct degradation: the drain itself is unaffected.
 */
function draw(frame: string): void {
    try {
        process.stderr.write(frame);
    } catch {
        // A dead or unwritable stderr means there is no one left to narrate to.
    }
}

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
        // `\r\x1b[2K` returns to column 0 and clears the row, so each frame overwrites the last
        // in place instead of scrolling a new line per tick. Width is re-read every frame so a
        // resize mid-drain is picked up without a SIGWINCH listener to unregister.
        draw(`\r\x1b[2K${exitIndicatorFrame(glyph, startedAt, process.stderr.columns ?? INDICATOR_FALLBACK_COLUMNS)}`);
    }, INDICATOR_FRAME_MS);
    // The indicator must never be the reason the process stays alive: `beforeExit` reaches
    // `shutdown()` precisely when nothing else is pending, and a ref'd timer would re-arm the loop.
    timer.unref();

    return () => {
        clearInterval(timer);
        // Erase only what was drawn. Below the delay the indicator never wrote, and clearing the row
        // would wipe whatever the command legitimately left on the last line.
        if (Date.now() - startedAt >= INDICATOR_DELAY_MS) draw("\r\x1b[2K");
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
