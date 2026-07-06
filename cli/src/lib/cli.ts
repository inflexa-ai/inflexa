import { confirm as clackConfirm, isCancel, select as clackSelect, text as clackText } from "@clack/prompts";

import { shutdown } from "./shutdown.ts";

// CLI-boundary helpers shared by the text command actions: print-and-exit on fatal errors,
// and an interactive y/N confirm (via @clack/prompts). They live in lib/ (infrastructure)
// rather than src/cli/ (the command registry) and stay decoupled from any domain — `dieOn`
// is typed structurally so it never has to import `DbError`. The prompts here serve the
// line-based text commands only; the opentui TUI owns the terminal separately (see below).

/** Print `message` (with an optional cause) to stderr and exit non-zero — a fatal CLI bail-out. */
export function fail(message: string, cause?: unknown): never {
    console.error(message, cause ?? "");
    process.exit(1);
}

/**
 * POST-WORK failure exit: print `message` to stderr, then exit non-zero VIA the
 * shutdown path so every registered `onShutdown` hook runs first. Its counterpart
 * {@link fail} is the PRE-FLIGHT bail-out — a bare `process.exit(1)` for the boundary
 * where nothing is pending yet, which by design SKIPS the shutdown hooks. Reach for
 * this once work with pending effects has run: a failed analysis run must flush its
 * signed provenance document (the `prov.run_completed`/`prov.file_written` events still
 * in the recorder's pending flush, drained by `onShutdown(flushProvenanceAsync)`) before
 * the process dies — exiting via `fail()` there would race or skip that flush and lose
 * the very record the flush exists to guarantee. Mirrors `fail`'s stderr shape exactly
 * (message + its empty cause slot) so the two exits read identically.
 */
export function failViaShutdown(message: string): Promise<never> {
    console.error(message, "");
    return shutdown(1);
}

/**
 * Error branch for `Result.match` at a CLI entry point: prints `<message>: <error.type>`
 * with the cause, then exits non-zero. Pairs with an identity success branch —
 * `const rows = listAnchors().match((a) => a, dieOn("Failed to list anchors"))` — so
 * neverthrow's must-use rule still sees the Result consumed. Typed against any
 * `{ type, cause }` so it works with `DbError` without coupling lib/ to db/.
 */
export function dieOn(message: string): (error: { type: string; cause?: unknown }) => never {
    return (error) => fail(`${message}: ${error.type}`, error.cause);
}

/**
 * Interactive y/N confirmation for the text commands. On a TTY it is a clack prompt; with a
 * non-interactive stdin (pipe / heredoc / CI) it falls back to a line read so a scripted
 * `echo y | inflexa …` is still honored. Returns false on No, on cancel (Ctrl-C / Esc), and on
 * empty input / EOF (e.g. `</dev/null`) — genuine silence never proceeds. Text-command layer
 * ONLY — never call this from the opentui TUI, which owns the terminal in alternate-screen
 * mode and cannot share it with clack.
 */
export async function confirm(question: string): Promise<boolean> {
    if (process.stdin.isTTY) {
        const answer = await clackConfirm({ message: question, initialValue: false });
        return !isCancel(answer) && answer === true;
    }

    // Non-interactive stdin: clack reads raw keypresses and can't run headless, but a piped
    // answer is an explicit instruction, so honor it. Drain stdin to EOF rather than using
    // readline's question(), which hangs on an already-closed stream under Bun; an empty read
    // (EOF / </dev/null) declines, so a destructive op never proceeds on silence.
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const answer = Buffer.concat(chunks).toString().trim().toLowerCase();
    return answer === "y" || answer === "yes";
}

/**
 * Interactive free-text prompt for the text commands (e.g. an analysis name). Optionally
 * validates as the user types — `validate` returns an error string to re-ask, or `undefined`
 * when the value is acceptable. TTY-only: a selection/typed value cannot be obtained
 * headless, so a non-interactive stdin fails fast (the caller should supply the value as an
 * argument). Cancelling (Ctrl-C / Esc) aborts the command. Text-command layer ONLY — never
 * from the opentui TUI, which owns the terminal in alternate-screen mode.
 */
export async function promptText(
    message: string,
    opts?: {
        validate?: (value: string) => string | undefined;
        /** Visual hint shown when the field is empty. */
        placeholder?: string;
        /** Fallback returned when the user submits empty input (press Enter to accept). */
        defaultValue?: string;
    },
): Promise<string> {
    if (!process.stdin.isTTY) fail(`${message}: a value is required, but stdin is not interactive — pass it as an argument.`);
    const validate = opts?.validate;
    const answer = await clackText({
        message,
        placeholder: opts?.placeholder,
        defaultValue: opts?.defaultValue,
        validate: validate ? (v) => validate(v ?? "") : undefined,
    });
    if (isCancel(answer)) fail("Cancelled.");
    return answer;
}

/**
 * Interactive single-choice picker for the text commands, returning the chosen option's
 * string `value`. Callers key options by an id/sentinel and map back to the real object.
 * TTY-only (see {@link promptText}); cancelling aborts the command. Text-command layer ONLY —
 * never from the opentui TUI.
 */
export async function select(message: string, options: { value: string; label: string }[]): Promise<string> {
    if (!process.stdin.isTTY) fail(`${message}: a selection is required, but stdin is not interactive.`);
    const answer = await clackSelect({ message, options });
    if (isCancel(answer)) fail("Cancelled.");
    return answer;
}
