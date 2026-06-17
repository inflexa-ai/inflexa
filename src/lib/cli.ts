import { confirm as clackConfirm, isCancel } from "@clack/prompts";

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
 * `echo y | inf …` is still honored. Returns false on No, on cancel (Ctrl-C / Esc), and on
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
