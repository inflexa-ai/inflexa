import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import pkg from "../../../package.json";
import { env } from "../../lib/env.ts";
import { __setCompiledBinaryForTest } from "../../lib/install_context.ts";
import { __releaseUpdateNoticeClaimForTest, claimDailyAsk, claimUpdateNotice, printUpdateNotice, updateOffer } from "./notice.ts";

const realWrite = process.stderr.write.bind(process.stderr);
const realIsTTY = process.stderr.isTTY;

/** Run `body` with stderr faked as a terminal, and give back everything it wrote. */
function captureStderr(isTTY: boolean, body: () => void): string {
    const written: string[] = [];
    Object.defineProperty(process.stderr, "isTTY", { value: isTTY, configurable: true });
    process.stderr.write = ((chunk: string) => {
        written.push(String(chunk));
        return true;
    }) as typeof process.stderr.write;
    body();
    return written.join("");
}

afterEach(() => {
    process.stderr.write = realWrite;
    Object.defineProperty(process.stderr, "isTTY", { value: realIsTTY, configurable: true });
    __setCompiledBinaryForTest(null);
    __releaseUpdateNoticeClaimForTest();
    rmSync(env.updateStatePath, { force: true });
});

describe("printUpdateNotice", () => {
    test("names both versions and the command that installs the new one", () => {
        __setCompiledBinaryForTest(true);
        const out = captureStderr(true, () => printUpdateNotice("99.0.0"));
        expect(out).toContain("99.0.0");
        expect(out).toContain(pkg.version);
        expect(out).toContain("inflexa upgrade");
    });

    test("says nothing when there is no newer release", () => {
        expect(captureStderr(true, () => printUpdateNotice(null))).toBe("");
    });

    test("says nothing when stderr is not a terminal", () => {
        // A redirected stream is a file or a pipe that another program reads, and this text means nothing
        // to it. It is also what keeps the notice out of a captured subprocess.
        __setCompiledBinaryForTest(true);
        expect(captureStderr(false, () => printUpdateNotice("99.0.0"))).toBe("");
    });

    test("says nothing once a surface that owns the terminal has claimed the message", () => {
        // The TUI launchers return while the alternate screen is live, so an unclaimed write would paint
        // over the chat. The TUI asks its own question instead.
        __setCompiledBinaryForTest(true);
        claimUpdateNotice();
        expect(captureStderr(true, () => printUpdateNotice("99.0.0"))).toBe("");
    });

    test("a source run is told to update its checkout, not to run the upgrade command", () => {
        __setCompiledBinaryForTest(false);
        const out = captureStderr(true, () => printUpdateNotice("99.0.0"));
        expect(out).toContain("git pull");
    });

    test("prints one time inside a day, and a run with no terminal does not burn the day", () => {
        __setCompiledBinaryForTest(true);
        // The no-terminal run shows nothing, so the ask record must stay untouched.
        expect(captureStderr(false, () => printUpdateNotice("99.0.0"))).toBe("");
        expect(captureStderr(true, () => printUpdateNotice("99.0.0"))).toContain("99.0.0");
        expect(captureStderr(true, () => printUpdateNotice("99.0.0"))).toBe("");
    });
});

describe("claimDailyAsk", () => {
    const now = 1_000_000_000_000;

    test("the first ask passes, and it holds the same version for a day", () => {
        expect(claimDailyAsk("99.0.0", now)).toBe(true);
        expect(claimDailyAsk("99.0.0", now + 60_000)).toBe(false);
        expect(claimDailyAsk("99.0.0", now + 25 * 60 * 60 * 1000)).toBe(true);
    });

    test("a newer release passes inside the day, so a same-day release does not wait", () => {
        expect(claimDailyAsk("99.0.0", now)).toBe(true);
        expect(claimDailyAsk("99.0.1", now + 60_000)).toBe(true);
    });

    test("a refused claim keeps the record, so the day counts from the shown ask", () => {
        expect(claimDailyAsk("99.0.0", now)).toBe(true);
        expect(claimDailyAsk("99.0.0", now + 23 * 60 * 60 * 1000)).toBe(false);
        // 24 hours after the refused claim, but 47 after the shown one: the day ended, so it passes.
        expect(claimDailyAsk("99.0.0", now + 47 * 60 * 60 * 1000)).toBe(true);
    });

    test("an unreadable record costs one extra ask, never a failure", () => {
        mkdirSync(dirname(env.updateStatePath), { recursive: true });
        writeFileSync(env.updateStatePath, "{ this is not json");
        expect(claimDailyAsk("99.0.0", now)).toBe(true);
    });

    test("a record from the old shape reads as no record", () => {
        // A machine that updates across this change holds `{checkedAt, version}`. That shape must cost
        // one extra ask, not a failure and not a held ask.
        mkdirSync(dirname(env.updateStatePath), { recursive: true });
        writeFileSync(env.updateStatePath, JSON.stringify({ checkedAt: now - 60_000, version: "99.0.0" }));
        expect(claimDailyAsk("99.0.0", now)).toBe(true);
    });
});

describe("updateOffer", () => {
    test("no newer release is nothing to say, on every channel", () => {
        expect(updateOffer(null, "installer")).toEqual({ kind: "none" });
        expect(updateOffer(null, "homebrew")).toEqual({ kind: "none" });
    });

    test("an installer install is asked, because inflexa can act on the answer", () => {
        expect(updateOffer("99.0.0", "installer")).toEqual({ kind: "ask", version: "99.0.0" });
    });

    test("a managed install is told, because a question with no answer in it is not a question", () => {
        expect(updateOffer("99.0.0", "homebrew")).toEqual({ kind: "tell", version: "99.0.0", instruction: "brew upgrade inflexa" });
        expect(updateOffer("99.0.0", "npm")).toEqual({ kind: "tell", version: "99.0.0", instruction: "npm install -g @inflexa-ai/inflexa@latest" });
    });
});
