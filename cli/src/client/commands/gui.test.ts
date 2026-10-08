import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";

import { freshDb } from "../../test_support/db.ts";
import { startTestServer, type TestServer } from "../../test_support/server.ts";
import { gui, type GuiOpts } from "./gui.ts";

let server: TestServer;

beforeEach(() => {
    freshDb();
    server = startTestServer();
});

afterEach(async () => {
    await server.stop();
});

/** The options of a run against the test server. */
function guiOpts(open: GuiOpts["open"]): { opts: GuiOpts; lines: string[] } {
    const lines: string[] = [];
    return { opts: { ...server.clientOpts, open, write: (line) => void lines.push(line) }, lines };
}

describe("inflexa gui", () => {
    test("it prints the sign-in link with a new nonce and `next=/gui/`, and it opens the same link", async () => {
        const opened: string[] = [];
        const { opts, lines } = guiOpts((target) => {
            opened.push(target);
            return ok(undefined);
        });

        await gui(opts);

        const link = lines[0] ?? "";
        const url = new URL(link);
        expect(url.origin).toBe(server.baseUrl);
        expect(url.pathname).toBe("/api/v1/session");
        expect(url.searchParams.get("next")).toBe("/gui/");
        expect(url.searchParams.get("nonce")).toMatch(/^[0-9a-f]{64}$/);
        expect(lines[1]).toContain("one time");
        expect(lines[1]).toContain("60 s");
        expect(opened).toEqual([link]);
    });

    test("the printed link signs a browser in once", async () => {
        const { opts, lines } = guiOpts(() => ok(undefined));
        await gui(opts);
        const link = lines[0] ?? "";

        const first = await fetch(link, { redirect: "manual" });
        expect(first.status).toBe(303);
        expect(first.headers.get("Location")).toBe("/gui/");
        expect(first.headers.get("Set-Cookie")).toContain(`inflexa_session_${server.port}=`);
        expect((await fetch(link, { redirect: "manual" })).status).toBe(401);
    });

    test("each run makes a new nonce", async () => {
        const { opts, lines } = guiOpts(() => ok(undefined));
        await gui(opts);
        await gui(opts);
        const nonces = lines.filter((line) => line.startsWith("http")).map((line) => new URL(line).searchParams.get("nonce"));
        expect(nonces).toHaveLength(2);
        expect(nonces[0]).not.toBe(nonces[1]);
    });

    test("when the open fails, it still prints the link and says that the open failed", async () => {
        const { opts, lines } = guiOpts(() => err({ type: "open_failed", code: "ENOENT", cause: new Error("no opener") }));

        await gui(opts);

        expect(lines[0]).toStartWith(`${server.baseUrl}/api/v1/session?nonce=`);
        expect(lines.at(-1)).toContain("could not open a browser");
    });
});
