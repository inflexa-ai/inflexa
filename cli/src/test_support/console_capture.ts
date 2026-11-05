import { describeCause } from "../lib/cause.ts";

/** What one {@link captureConsole} run printed, with the exit code the run left behind. */
export type CapturedConsole = {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: typeof process.exitCode;
};

/**
 * Run `fn` with stdout (console.log) and stderr (console.error) captured as strings, modeling the
 * trailing newline the real streams add per call so byte-stability can be asserted on the exact
 * bytes. Restores both streams afterwards — also when `fn` throws — and restores `process.exitCode`
 * with an explicit 0 when it was unset: Bun ignores an `undefined` assignment, so a captured failure
 * code would otherwise leak and fail the whole single-process `bun test` run.
 */
export async function captureConsole(fn: () => Promise<void>): Promise<CapturedConsole> {
    const origLog = console.log;
    const origError = console.error;
    const origExitCode = process.exitCode;
    let stdout = "";
    let stderr = "";
    console.log = (msg?: unknown) => {
        stdout += `${describeCause(msg)}\n`;
    };
    console.error = (msg?: unknown) => {
        stderr += `${describeCause(msg)}\n`;
    };
    try {
        await fn();
        return { stdout, stderr, exitCode: process.exitCode };
    } finally {
        console.log = origLog;
        console.error = origError;
        process.exitCode = origExitCode ?? 0;
    }
}
