import { describe, expect, test } from "bun:test";

import pkg from "../../../package.json";
import type { FetchLike } from "../../lib/download.ts";
import { fetchLatestVersion, isNewerVersion, readNewerVersion, updateReadAllowed } from "./latest.ts";

/** A stub of the `releases/latest` redirect: answers 302 to the tag of `version`. */
function redirectTo(version: string): FetchLike {
    return async () => new Response(null, { status: 302, headers: { location: `https://github.com/inflexa-ai/inflexa/releases/tag/v${version}` } });
}

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
    test("a newer release than the running version is the answer", async () => {
        expect(await readNewerVersion(redirectTo("99.1.0"))).toBe("99.1.0");
    });

    test("a release that is not newer is nothing to say", async () => {
        expect(await readNewerVersion(redirectTo(pkg.version))).toBeNull();
    });

    test("a failed read is nothing to say, never a failure", async () => {
        expect(await readNewerVersion(async () => new Response("", { status: 503 }))).toBeNull();
    });

    test("the network is read at each call, so a same-day release is seen", async () => {
        // No record holds the second call: a release that lands after the first read of the day must
        // not wait out that day.
        expect(await readNewerVersion(redirectTo(pkg.version))).toBeNull();
        expect(await readNewerVersion(redirectTo("99.1.0"))).toBe("99.1.0");
    });
});
