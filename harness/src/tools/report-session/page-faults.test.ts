/**
 * The tests of the fault digest of one look: the inline data placeholders, the cap of one text, the
 * collapse of a repeat, and the cap of one list.
 */

import { describe, expect, it } from "bun:test";

import { digestPageFaults, shortenFaultText } from "./page-faults.js";

/** A base64 body of the given length, as a blocked inline font logs it. */
function base64Body(length: number): string {
    return "d09GMgABAAAAA".repeat(Math.ceil(length / 13)).slice(0, length);
}

describe("the inline data", () => {
    it("replaces a data URI with its media type and the length of its data", () => {
        const text = `Refused to load the font 'data:font/woff2;base64,${base64Body(48_000)}' because it violates the following Content Security Policy directive: "font-src 'self'".`;

        expect(shortenFaultText(text)).toBe(
            `Refused to load the font '[inline font/woff2 data, 48000 chars]' because it violates the following Content Security Policy directive: "font-src 'self'".`,
        );
    });

    it("names the default media type of a data URI that states none", () => {
        expect(shortenFaultText("GET data:,Hello%2C%20World net::ERR_FAILED")).toBe("GET [inline text/plain data, 16 chars] net::ERR_FAILED");
    });

    it("replaces a long base64 run outside a data URI, and keeps a content hash", () => {
        const hash = "a".repeat(64);
        const text = `token ${base64Body(500)} for sha256:${hash}`;

        expect(shortenFaultText(text)).toBe(`token [base64 data, 500 chars] for sha256:${hash}`);
    });

    it("caps a long text, and marks the cut", () => {
        const shortened = shortenFaultText("x ".repeat(1000));

        expect(Array.from(shortened).length).toBe(300);
        expect(shortened.endsWith("…")).toBe(true);
    });
});

describe("the digest", () => {
    it("collapses each repeat into one entry with a count, in the order of the first occurrence", () => {
        const font = `Refused to load the font 'data:font/woff2;base64,${base64Body(40_000)}'`;
        const digest = digestPageFaults(
            [font, "boom", font, font, "boom", "late"],
            [
                { url: "assets/a.png", reason: "net::ERR_FILE_NOT_FOUND" },
                { url: "assets/a.png", reason: "net::ERR_FILE_NOT_FOUND" },
                { url: "assets/a.png", reason: "net::ERR_ABORTED" },
            ],
        );

        expect(digest.consoleErrors).toEqual([
            { text: "Refused to load the font '[inline font/woff2 data, 40000 chars]'", count: 3 },
            { text: "boom", count: 2 },
            { text: "late", count: 1 },
        ]);
        // A request collapses on its URL and its reason together, thus two reasons stay two entries.
        expect(digest.failedRequests).toEqual([
            { url: "assets/a.png", reason: "net::ERR_FILE_NOT_FOUND", count: 2 },
            { url: "assets/a.png", reason: "net::ERR_ABORTED", count: 1 },
        ]);
        expect(digest.omittedFaults).toBeUndefined();
    });

    it("caps each list, and counts the distinct entries that the cap left out", () => {
        const errors = Array.from({ length: 25 }, (_value, index) => `error ${index}`);
        const digest = digestPageFaults(errors, [{ url: "assets/b.png", reason: "net" }]);

        expect(digest.consoleErrors).toHaveLength(20);
        expect(digest.consoleErrors[19]).toEqual({ text: "error 19", count: 1 });
        expect(digest.omittedFaults).toEqual({ consoleErrors: 5, failedRequests: 0 });
    });

    it("gives two empty lists for a clean page", () => {
        expect(digestPageFaults([], [])).toEqual({ consoleErrors: [], failedRequests: [] });
    });
});
