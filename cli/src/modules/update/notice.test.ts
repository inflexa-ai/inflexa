import { afterEach, describe, expect, test } from "bun:test";

import pkg from "../../../package.json";
import { __setCompiledBinaryForTest } from "../../lib/install_context.ts";
import { __releaseUpdateNoticeClaimForTest, claimUpdateNotice, printUpdateNotice, updateOffer } from "./notice.ts";

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
