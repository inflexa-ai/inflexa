import { afterEach, describe, expect, test } from "bun:test";

import { startExitIndicator } from "./shutdown.ts";

// The indicator's grace period is a module constant (500ms). These tests exercise the real timers
// rather than injecting a clock: the whole contract is "stay silent unless the drain is genuinely
// slow", and a fake clock would test the injection instead of the behaviour that matters.
const PAST_GRACE_MS = 640;

const realIsTTY = process.stderr.isTTY;
const realWrite = process.stderr.write.bind(process.stderr);

/** Capture stderr for the duration of one test, returning the frames written. */
function captureStderr(isTTY: boolean): string[] {
    const frames: string[] = [];
    // `isTTY` is an own property of the stream in Node and Bun alike, so a plain assignment is the
    // supported way to simulate a pipe; `afterEach` restores both it and `write`.
    process.stderr.isTTY = isTTY;
    process.stderr.write = ((chunk: string) => {
        frames.push(chunk);
        return true;
    }) as typeof process.stderr.write;
    return frames;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
    process.stderr.isTTY = realIsTTY;
    process.stderr.write = realWrite;
});

describe("startExitIndicator", () => {
    test("writes nothing when stderr is not a TTY, however long the drain runs", async () => {
        const frames = captureStderr(false);
        const stop = startExitIndicator();
        await sleep(PAST_GRACE_MS);
        stop();
        expect(frames).toEqual([]);
    });

    test("stays silent for a drain that finishes inside the grace period", () => {
        const frames = captureStderr(true);
        startExitIndicator()();
        expect(frames).toEqual([]);
    });

    test("draws a spinner frame once the drain outlives the grace period", async () => {
        const frames = captureStderr(true);
        const stop = startExitIndicator();
        await sleep(PAST_GRACE_MS);
        stop();

        const drawn = frames.join("");
        expect(drawn).toContain("Exiting");
        expect(drawn).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
        // Elapsed seconds are what tell the reader the process is alive rather than wedged.
        expect(drawn).toMatch(/\(\d+s\)/);
    });

    test("erases its line on stop, so the shell prompt lands on a clean row", async () => {
        const frames = captureStderr(true);
        const stop = startExitIndicator();
        await sleep(PAST_GRACE_MS);
        stop();
        expect(frames.at(-1)).toBe("\r\x1b[2K");
    });
});
