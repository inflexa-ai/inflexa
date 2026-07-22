import { afterEach, describe, expect, test } from "bun:test";

import { exitIndicatorFrame, startExitIndicator } from "./shutdown.ts";

// The indicator's grace period is a module constant (500ms). These tests exercise the real timers
// rather than injecting a clock: the whole contract is "stay silent unless the drain is genuinely
// slow", and a fake clock would test the injection instead of the behaviour that matters.
const PAST_GRACE_MS = 640;

const realIsTTY = process.stderr.isTTY;
const realColumns = process.stderr.columns;
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
    process.stderr.columns = realColumns;
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
        // The age is what tells the reader the process is alive rather than wedged.
        expect(drawn).toMatch(/\(\d+s\)/);
    });

    test("erases its line on stop, so the shell prompt lands on a clean row", async () => {
        const frames = captureStderr(true);
        const stop = startExitIndicator();
        await sleep(PAST_GRACE_MS);
        stop();
        expect(frames.at(-1)).toBe("\r\x1b[2K");
    });

    test("survives a stderr that throws, so a dead terminal cannot crash the exit it narrates", async () => {
        process.stderr.isTTY = true;
        process.stderr.write = (() => {
            // What a real stderr does once the terminal goes away mid-drain (the SIGHUP path).
            throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        }) as typeof process.stderr.write;

        const stop = startExitIndicator();
        await sleep(PAST_GRACE_MS);
        expect(() => stop()).not.toThrow();
    });

    test("fits the row it is given, so a frame never wraps and smears down the screen", async () => {
        const frames = captureStderr(true);
        // Narrow enough that even the short variant with an age (`⠋ Exiting… (0s)`) overflows, so the
        // live path is proven to consult the width rather than merely happening to fit.
        process.stderr.columns = 12;
        const stop = startExitIndicator();
        await sleep(PAST_GRACE_MS);
        stop();

        const drawn = frames.map((f) => f.replace("\r\x1b[2K", "")).filter((f) => f.length > 0);
        expect(drawn.length).toBeGreaterThan(0);
        for (const frame of drawn) expect(frame.length).toBeLessThanOrEqual(11);
    });
});

describe("exitIndicatorFrame", () => {
    const GLYPH = "⠋";
    const WIDE = 200;

    test("renders the age through the shared formatter, not a hand-rolled one", () => {
        // 16 minutes is the drain this feature exists to explain; `960s` is the shape to avoid.
        expect(exitIndicatorFrame(GLYPH, Date.now() - 16 * 60_000, WIDE)).toContain("(16m00s)");
        expect(exitIndicatorFrame(GLYPH, Date.now() - 31_000, WIDE)).toContain("(31s)");
    });

    test("explains itself only once the drain outlives the explain threshold", () => {
        expect(exitIndicatorFrame(GLYPH, Date.now() - 1_000, WIDE)).toBe("⠋ Exiting… (1s)");
        expect(exitIndicatorFrame(GLYPH, Date.now() - 6_000, WIDE)).toContain("waiting for in-flight work");
    });

    test("still explains itself on a conventional 80-column row", () => {
        // The full explain variant is 80 columns with a two-unit age, so it cannot fit here. The
        // reader must still get an explanation rather than a bare `Exiting…` — this width is the
        // common case, not an edge one.
        const frame = exitIndicatorFrame(GLYPH, Date.now() - 16 * 60_000, 80);
        expect(frame).toBe("⠋ Exiting — waiting for in-flight work to finish (16m00s)");
        expect(frame.length).toBeLessThanOrEqual(79);
    });

    test("uses the full explanation when the row is wide enough for it", () => {
        expect(exitIndicatorFrame(GLYPH, Date.now() - 16 * 60_000, 120)).toBe(
            "⠋ Exiting — waiting for in-flight work to finish, this can take a while (16m00s)",
        );
    });

    test("degrades to the short message rather than truncating the age away", () => {
        // Too narrow for any explanation, wide enough to keep the age — which is the part that
        // distinguishes a live drain from a wedged one, and the part a plain truncation would cut.
        expect(exitIndicatorFrame(GLYPH, Date.now() - 16 * 60_000, 24)).toBe("⠋ Exiting… (16m00s)");
    });

    test("degrades to the bare glyph on a row too narrow for any message", () => {
        expect(exitIndicatorFrame(GLYPH, Date.now() - 6_000, 6)).toBe(GLYPH);
    });

    test("never exceeds its budget at any width, down to a degenerate row", () => {
        for (const columns of [0, 1, 2, 5, 12, 20, 40, 79, 80, 81, 120]) {
            const frame = exitIndicatorFrame(GLYPH, Date.now() - 6_000, columns);
            expect(frame.length).toBeLessThanOrEqual(Math.max(0, columns - 1));
        }
    });
});
