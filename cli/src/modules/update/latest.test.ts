import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import pkg from "../../../package.json";
import { env } from "../../lib/env.ts";
import type { FetchLike } from "../../lib/download.ts";
import { fetchLatestVersion, isNewerVersion, readNewerVersion, updateReadAllowed } from "./latest.ts";

/** A stub of the `releases/latest` redirect: answers 302 to the tag of `version`. */
function redirectTo(version: string): FetchLike {
    return async () => new Response(null, { status: 302, headers: { location: `https://github.com/inflexa-ai/inflexa/releases/tag/v${version}` } });
}

/** Record a read of `version` at `at`, the way a previous run would have left it. */
function recordRead(version: string, at: number): void {
    mkdirSync(dirname(env.updateStatePath), { recursive: true });
    writeFileSync(env.updateStatePath, JSON.stringify({ checkedAt: at, version }));
}

afterEach(() => {
    rmSync(env.updateStatePath, { force: true });
});

describe("isNewerVersion", () => {
    test("ranks by major, then minor, then patch", () => {
        expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
        expect(isNewerVersion("0.17.0", "0.16.9")).toBe(true);
        expect(isNewerVersion("0.16.2", "0.16.1")).toBe(true);
        expect(isNewerVersion("0.16.1", "0.16.1")).toBe(false);
        expect(isNewerVersion("0.16.0", "0.16.1")).toBe(false);
    });

    test("a version that does not parse is never newer, on either side", () => {
        // The safe direction: an unreadable version must not make the CLI offer an update it cannot name.
        expect(isNewerVersion("not-a-version", "0.16.1")).toBe(false);
        expect(isNewerVersion("9.9.9", "not-a-version")).toBe(false);
    });

    test("a pre-release suffix compares as its three numbers", () => {
        expect(isNewerVersion("0.17.0-rc.1", "0.16.1")).toBe(true);
        expect(isNewerVersion("0.17.0-rc.1", "0.17.0")).toBe(false);
    });
});

describe("fetchLatestVersion", () => {
    test("reads the version out of the redirect target, without its leading v", async () => {
        const result = await fetchLatestVersion(redirectTo("0.17.3"));
        expect(result._unsafeUnwrap()).toBe("0.17.3");
    });

    test("a redirect with no location header is an unexpected status", async () => {
        const result = await fetchLatestVersion(async () => new Response("", { status: 500 }));
        expect(result._unsafeUnwrapErr()).toEqual({ type: "unexpected_status", status: 500 });
    });

    test("a location that names no version reports what it saw", async () => {
        const location = "https://github.com/inflexa-ai/inflexa/releases";
        const result = await fetchLatestVersion(async () => new Response(null, { status: 302, headers: { location } }));
        expect(result._unsafeUnwrapErr()).toEqual({ type: "no_version", location });
    });

    test("a fetch that throws synchronously lands in the same error channel as one that rejects", async () => {
        const result = await fetchLatestVersion(() => {
            throw new Error("offline");
        });
        expect(result._unsafeUnwrapErr().type).toBe("network_failed");
    });
});

describe("updateReadAllowed", () => {
    test("only a compiled, released, unsuppressed run may look", () => {
        expect(updateReadAllowed(true, false, false)).toBe(true);
        expect(updateReadAllowed(false, false, false)).toBe(false);
        expect(updateReadAllowed(true, true, false)).toBe(false);
        expect(updateReadAllowed(true, false, true)).toBe(false);
    });
});

describe("readNewerVersion", () => {
    test("a recorded read from within the day answers without touching the network", async () => {
        const now = 1_000_000_000_000;
        recordRead("99.0.0", now - 60_000);
        const found = await readNewerVersion({
            now,
            fetch: () => {
                throw new Error("the network must not be read");
            },
        });
        expect(found).toBe("99.0.0");
    });

    test("a recorded read older than a day is read again", async () => {
        const now = 1_000_000_000_000;
        recordRead("0.0.1", now - 25 * 60 * 60 * 1000);
        expect(await readNewerVersion({ now, fetch: redirectTo("99.1.0") })).toBe("99.1.0");
    });

    test("a read that finds nothing newer answers null and still holds the next read for a day", async () => {
        const now = 1_000_000_000_000;
        expect(await readNewerVersion({ now, fetch: redirectTo(pkg.version) })).toBeNull();

        // The record's job is to hold the NEXT read, and that job does not depend on what this one found.
        const later = await readNewerVersion({
            now: now + 60_000,
            fetch: () => {
                throw new Error("the network must not be read");
            },
        });
        expect(later).toBeNull();
    });

    test("a failed read answers null and records nothing, so the next run reads again", async () => {
        const now = 1_000_000_000_000;
        expect(
            await readNewerVersion({
                now,
                fetch: async () => new Response("", { status: 503 }),
            }),
        ).toBeNull();

        let reads = 0;
        await readNewerVersion({
            now: now + 60_000,
            fetch: (...args) => {
                reads += 1;
                return redirectTo("99.2.0")(...args);
            },
        });
        expect(reads).toBe(1);
    });

    test("an unreadable record costs one network read, never a failure", async () => {
        mkdirSync(dirname(env.updateStatePath), { recursive: true });
        writeFileSync(env.updateStatePath, "{ this is not json");
        expect(await readNewerVersion({ now: 1_000_000_000_000, fetch: redirectTo("99.3.0") })).toBe("99.3.0");
    });
});
