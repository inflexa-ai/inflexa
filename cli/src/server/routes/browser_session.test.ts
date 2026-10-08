import { describe, expect, test } from "bun:test";

import type { SessionNonce } from "../../api/browser_session.ts";
import { signIn } from "../../test_support/browser_session.ts";
import { idleBoot, idleLifecycle } from "../../test_support/server.ts";
import { buildApp } from "../app.ts";

const TOKEN = "a".repeat(64);
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const START = Date.parse("2026-10-08T10:00:00.000Z");

/** An app on a clock that a test moves. */
function appWithClock(): { app: ReturnType<typeof buildApp>; advance: (ms: number) => void } {
    let at = START;
    return {
        app: buildApp({ token: TOKEN, lifecycle: idleLifecycle(), boot: idleBoot() }, { now: () => at }),
        advance: (ms) => void (at += ms),
    };
}

async function getNonce(app: ReturnType<typeof buildApp>): Promise<SessionNonce> {
    const response = await app.request("/api/v1/session/nonce", { method: "POST", headers: AUTH });
    expect(response.status).toBe(201);
    // The nonce route sends a `SessionNonce` body on 201.
    return (await response.json()) as SessionNonce;
}

/** The sign-in link GET, with no credential. */
async function open(app: ReturnType<typeof buildApp>, query: string, headers: Record<string, string> = {}): Promise<Response> {
    return await app.request(`/api/v1/session?${query}`, { headers });
}

async function expectSignInAgain(response: Response): Promise<void> {
    expect(response.status).toBe(401);
    // An error body of the app is an `ApiError`.
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("unauthorized");
    expect(body.message).toContain("`inflexa gui`");
    expect(response.headers.get("Set-Cookie")).toBeNull();
}

describe("POST /api/v1/session/nonce", () => {
    test("the bearer token gets 201 with a nonce that expires in 60 s", async () => {
        const { app } = appWithClock();
        const { nonce, expiresAt } = await getNonce(app);
        expect(nonce).toMatch(/^[0-9a-f]{64}$/);
        expect(Date.parse(expiresAt)).toBe(START + 60_000);
    });

    test("a session cookie gets 403 `forbidden`", async () => {
        const { app } = appWithClock();
        const cookie = await signIn(app, TOKEN);
        const response = await app.request("/api/v1/session/nonce", { method: "POST", headers: { Cookie: cookie } });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: "forbidden" });
    });

    test("a request with no credential gets 401", async () => {
        const { app } = appWithClock();
        expect((await app.request("/api/v1/session/nonce", { method: "POST" })).status).toBe(401);
    });
});

describe("GET /api/v1/session", () => {
    test("a valid nonce sets the cookie and moves to `next` with 303", async () => {
        const { app, advance } = appWithClock();
        const { nonce } = await getNonce(app);
        advance(10_000);
        const response = await open(app, `nonce=${nonce}&next=/gui/`);
        expect(response.status).toBe(303);
        expect(response.headers.get("Location")).toBe("/gui/");
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        const cookie = response.headers.get("Set-Cookie") ?? "";
        expect(cookie).toStartWith("inflexa_session=");
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Strict");
        expect(cookie).toContain("Path=/api");
        expect(cookie).not.toContain("Max-Age");
        expect(cookie).not.toContain("Expires");
        expect(cookie).not.toContain("Secure");
    });

    test("the cookie holds a session secret of 32 bytes in hex, never the token or the nonce", async () => {
        const { app } = appWithClock();
        const { nonce } = await getNonce(app);
        const response = await open(app, `nonce=${nonce}`);
        const cookie = response.headers.get("Set-Cookie") ?? "";
        const value = cookie.split(";")[0]?.split("=")[1];
        expect(value).toMatch(/^[0-9a-f]{64}$/);
        expect(value).not.toBe(TOKEN);
        expect(value).not.toBe(nonce);
        expect(cookie).not.toContain(TOKEN);
    });

    test("the name of the cookie carries the port of the listener", async () => {
        const { app } = appWithClock();
        const listener = { port: 8436 };
        const host = { Host: "127.0.0.1:8436" };
        const issued = await app.request("/api/v1/session/nonce", { method: "POST", headers: { ...AUTH, ...host } }, listener);
        const { nonce } = (await issued.json()) as SessionNonce;
        const response = await app.request(`/api/v1/session?nonce=${nonce}`, { headers: host }, listener);
        expect(response.headers.get("Set-Cookie")).toStartWith("inflexa_session_8436=");
    });

    test("an absent `next` means /gui/", async () => {
        const { app } = appWithClock();
        const { nonce } = await getNonce(app);
        const response = await open(app, `nonce=${nonce}`);
        expect(response.status).toBe(303);
        expect(response.headers.get("Location")).toBe("/gui/");
    });

    test("a path with a query passes as `next`", async () => {
        const { app } = appWithClock();
        const { nonce } = await getNonce(app);
        const response = await open(app, `nonce=${nonce}&next=${encodeURIComponent("/gui/a?b=c")}`);
        expect(response.status).toBe(303);
        expect(response.headers.get("Location")).toBe("/gui/a?b=c");
    });

    test("a nonce works one time", async () => {
        const { app } = appWithClock();
        const { nonce } = await getNonce(app);
        expect((await open(app, `nonce=${nonce}`)).status).toBe(303);
        await expectSignInAgain(await open(app, `nonce=${nonce}`));
    });

    test("an expired nonce gets 401 and sets no cookie", async () => {
        const { app, advance } = appWithClock();
        const { nonce } = await getNonce(app);
        advance(61_000);
        await expectSignInAgain(await open(app, `nonce=${nonce}&next=/gui/`));
    });

    test("an unknown nonce, an empty nonce, and an absent nonce get 401 and set no cookie", async () => {
        const { app } = appWithClock();
        await expectSignInAgain(await open(app, `nonce=${"f".repeat(64)}`));
        await expectSignInAgain(await open(app, "nonce="));
        await expectSignInAgain(await open(app, "next=/gui/"));
    });

    test("a `next` that is not a path of the server gets 400 `validation_error`, and the nonce stays usable", async () => {
        const { app } = appWithClock();
        const { nonce } = await getNonce(app);
        const refused = [
            "//evil.example/",
            "/%09/evil.example",
            "/%0d%0aSet-Cookie:x=1",
            "/%0a",
            "/a%20b",
            "/%5Cevil.example",
            "https://evil.example/",
            "gui/",
            "",
            "/%C3%A9",
        ];
        for (const next of refused) {
            const response = await open(app, `nonce=${nonce}&next=${next}`);
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ error: "validation_error" });
            expect(response.headers.get("Set-Cookie")).toBeNull();
        }
        expect((await open(app, `nonce=${nonce}&next=/gui/`)).status).toBe(303);
    });

    test("a new sign-in with an old cookie sets a new cookie of the same name", async () => {
        const { app } = appWithClock();
        const old = await signIn(app, TOKEN);
        const { nonce } = await getNonce(app);
        const response = await open(app, `nonce=${nonce}`, { Cookie: old });
        expect(response.status).toBe(303);
        const fresh = response.headers.get("Set-Cookie")?.split(";")[0] ?? "";
        expect(fresh.split("=")[0]).toBe(old.split("=")[0]);
        expect(fresh).not.toBe(old);
    });
});

describe("the sessions after sign-in", () => {
    test("the cookie opens an API route, and each tab of the origin shares it", async () => {
        const { app } = appWithClock();
        const cookie = await signIn(app, TOKEN);
        for (let tab = 0; tab < 2; tab++) {
            expect((await app.request("/api/v1/server", { headers: { Cookie: cookie } })).status).toBe(200);
        }
    });

    test("a restart is a new app that refuses the old cookie, and the message names `inflexa gui`", async () => {
        const { app } = appWithClock();
        const cookie = await signIn(app, TOKEN);
        const restarted = appWithClock().app;
        const response = await restarted.request("/api/v1/server", { headers: { Cookie: cookie } });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: "unauthorized", message: expect.stringContaining("`inflexa gui`") });
    });

    test("a request of a page of a different local port gets the message for a missing token", async () => {
        const { app } = appWithClock();
        const cookie = await signIn(app, TOKEN);
        const response = await app.request("/api/v1/server", { headers: { Cookie: cookie, "Sec-Fetch-Site": "same-site" } });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: "unauthorized", message: expect.stringContaining("Authorization: Bearer") });
    });
});
