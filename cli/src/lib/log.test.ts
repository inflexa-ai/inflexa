import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { localDay, msUntilNextLocalMidnight, rotatedLogFile, scheduleMidnightRoll, type RollableDestination } from "./log.ts";

const roots: string[] = [];
function root(): string {
    const p = mkdtempSync(join(tmpdir(), "inflexa-log-"));
    roots.push(p);
    return p;
}
afterEach(() => {
    for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

/** The stamp of the day `days` before `now`, on the local calendar the sweep reads. */
function stampDaysBack(now: Date, days: number): string {
    return localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
}

/** One armed timer: the callback and the delay the roll asked for. */
type Armed = { fn: () => void; ms: number };

/** A destination that records the roll's calls instead of touching an fd. `flush` calls back inline, which is the order sonic-boom guarantees for an empty buffer. */
function recordingDestination(calls: string[], reopen?: (file: string) => void): RollableDestination {
    return {
        flush(cb) {
            calls.push("flush");
            cb();
        },
        reopen(file) {
            calls.push(`reopen:${file}`);
            reopen?.(file);
        },
    };
}

describe("localDay", () => {
    test("renders the local calendar date, zero-padded", () => {
        expect(localDay(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
        expect(localDay(new Date(2026, 10, 30, 0, 30))).toBe("2026-11-30");
    });

    test("names the day the clock shows, where an ISO slice would name the UTC day", () => {
        // 00:30 sits on the previous UTC day east of Greenwich and 23:30 on the next UTC day west of
        // it: the two instants an ISO slice got wrong. A machine at UTC renders both the same way
        // whichever calendar is used, so the pin is on the rendered value rather than on a
        // difference the runner may not have, and the regression shows wherever there is an offset.
        expect(localDay(new Date(2026, 0, 6, 0, 30))).toBe("2026-01-06");
        expect(localDay(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
    });
});

describe("msUntilNextLocalMidnight", () => {
    test("gives the distance from an evening instant to the coming midnight", () => {
        // 2026-05-13 carries no daylight-saving transition in the zones this runs in, so the
        // distance is the plain wall-clock remainder of the day.
        expect(msUntilNextLocalMidnight(new Date(2026, 4, 12, 23, 59, 30, 250))).toBe(29_750);
    });

    test("gives a whole day at local midnight itself, not zero", () => {
        const atMidnight = new Date(2026, 4, 12, 0, 0, 0, 0);
        const nextMidnight = new Date(2026, 4, 13, 0, 0, 0, 0);
        expect(msUntilNextLocalMidnight(atMidnight)).toBe(nextMidnight.getTime() - atMidnight.getTime());
    });
});

describe("rotatedLogFile", () => {
    test("names the file for the local day of the instant", () => {
        const dir = root();
        expect(rotatedLogFile(dir, new Date(2026, 6, 4, 1, 0))).toBe(join(dir, "inflexa-2026-07-04.log"));
    });

    test("moves to the numbered sibling when the file of the day is at 20 MB", () => {
        const dir = root();
        const full = join(dir, "inflexa-2026-07-04.log");
        writeFileSync(full, "");
        // A sparse truncate reaches the 20 MB threshold without writing 20 MB.
        truncateSync(full, 20 * 1024 * 1024);
        expect(rotatedLogFile(dir, new Date(2026, 6, 4, 1, 0))).toBe(join(dir, "inflexa-2026-07-04.2.log"));
    });

    test("sweeps a file older than the retention window and keeps a newer one", () => {
        const dir = root();
        const now = new Date(2026, 6, 15, 9, 30);
        const stale = join(dir, `inflexa-${stampDaysBack(now, 8)}.log`);
        const recent = join(dir, `inflexa-${stampDaysBack(now, 6)}.log`);
        const foreign = join(dir, "notes.txt");
        writeFileSync(stale, "old");
        writeFileSync(recent, "new");
        writeFileSync(foreign, "unrelated");

        expect(rotatedLogFile(dir, now)).toBe(join(dir, "inflexa-2026-07-15.log"));
        expect(existsSync(stale)).toBe(false);
        expect(existsSync(recent)).toBe(true);
        expect(existsSync(foreign)).toBe(true);
    });
});

describe("scheduleMidnightRoll", () => {
    test("flushes, reopens on the file of the new day, and arms the timer again", () => {
        const dir = root();
        const armed: Armed[] = [];
        const calls: string[] = [];
        const day = new Date(2026, 6, 4, 12, 0);
        const midnight = new Date(2026, 6, 5, 0, 0, 0, 5);
        let now = day;

        scheduleMidnightRoll(recordingDestination(calls), {
            dir,
            currentFile: join(dir, "inflexa-2026-07-04.log"),
            now: () => now,
            setTimer: (fn, ms) => armed.push({ fn, ms }),
        });
        expect(armed.map((a) => a.ms)).toEqual([msUntilNextLocalMidnight(day)]);

        now = midnight;
        // Index 0 exists: the assertion above proves the arming inside scheduleMidnightRoll ran.
        armed[0]!.fn();

        expect(calls).toEqual(["flush", `reopen:${join(dir, "inflexa-2026-07-05.log")}`]);
        // Measured from the late fire, not from the boundary it was armed for.
        expect(armed.map((a) => a.ms)).toEqual([msUntilNextLocalMidnight(day), msUntilNextLocalMidnight(midnight)]);
    });

    test("only arms the timer again when the name did not change", () => {
        const dir = root();
        const armed: Armed[] = [];
        const calls: string[] = [];
        const day = new Date(2026, 6, 4, 12, 0);

        scheduleMidnightRoll(recordingDestination(calls), {
            dir,
            currentFile: join(dir, "inflexa-2026-07-04.log"),
            now: () => day,
            setTimer: (fn, ms) => armed.push({ fn, ms }),
        });
        armed[0]!.fn(); // index 0 exists: scheduleMidnightRoll arms the timer in its own body

        expect(calls).toEqual([]);
        expect(armed.length).toBe(2);
    });

    test("keeps the timer armed, and the file behind, when the reopen throws", () => {
        const dir = root();
        const armed: Armed[] = [];
        const calls: string[] = [];
        const day = new Date(2026, 6, 4, 12, 0);
        let now = day;
        const destination = recordingDestination(calls, () => {
            throw new Error("EACCES");
        });

        scheduleMidnightRoll(destination, {
            dir,
            currentFile: join(dir, "inflexa-2026-07-04.log"),
            now: () => now,
            setTimer: (fn, ms) => armed.push({ fn, ms }),
        });
        now = new Date(2026, 6, 5, 0, 0);
        armed[0]!.fn(); // index 0 exists: scheduleMidnightRoll arms the timer in its own body
        expect(armed.length).toBe(2);

        // The current file did not advance, so the next boundary attempts the same swap again.
        now = new Date(2026, 6, 6, 0, 0);
        armed[1]!.fn(); // index 1 exists: the assertion above counts it
        expect(calls).toEqual(["flush", `reopen:${join(dir, "inflexa-2026-07-05.log")}`, "flush", `reopen:${join(dir, "inflexa-2026-07-06.log")}`]);
        expect(armed.length).toBe(3);
    });

    test("skips the reopen when the flush reports an error", () => {
        const dir = root();
        const armed: Armed[] = [];
        const calls: string[] = [];
        const day = new Date(2026, 6, 4, 12, 0);
        let now = day;
        const destination: RollableDestination = {
            flush(cb) {
                calls.push("flush");
                cb(new Error("ENOSPC"));
            },
            reopen(file) {
                calls.push(`reopen:${file}`);
            },
        };

        scheduleMidnightRoll(destination, {
            dir,
            currentFile: join(dir, "inflexa-2026-07-04.log"),
            now: () => now,
            setTimer: (fn, ms) => armed.push({ fn, ms }),
        });
        now = new Date(2026, 6, 5, 0, 0);
        armed[0]!.fn(); // index 0 exists: scheduleMidnightRoll arms the timer in its own body

        expect(calls).toEqual(["flush"]);
        expect(armed.length).toBe(2);
    });
});
