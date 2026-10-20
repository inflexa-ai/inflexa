import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLocalAuth } from "@inflexa-ai/harness";
import { PAGE_ASSETS } from "@inflexa-ai/harness/report-render/assets.js";
import type { Hono } from "hono";

import type { ApiError } from "../../api/common.ts";
import type { ReportSessionAccess } from "../../api/conversation.ts";
import { mintReportSessionAccess } from "../../client/conversation.ts";
import { insertAnalysis, insertAnchor } from "../../db/primary_mutation.ts";
import { releaseInstanceLock } from "../../lib/lock.ts";
import { asStr256 } from "../../lib/types.ts";
import { invalidateWorkspaceRoot, workspaceRootForAnalysisId } from "../../modules/analysis/output.ts";
import { writeMarker } from "../../modules/anchor/marker.ts";
import { signIn } from "../../test_support/browser_session.ts";
import { fakeClient } from "../../test_support/fake_client.ts";
import { freshDb } from "../../test_support/db.ts";
import { idleBoot, idleLifecycle } from "../../test_support/server.ts";
import { buildApp } from "../app.ts";
import type { ServerEnv } from "../http.ts";
import { createPageGrantStore, createSessionPagePublisherFactory, type PageGrantStore } from "../report_page_grants.ts";

const TOKEN = "b".repeat(64);
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const UNAUTHORIZED_MESSAGE = "The link of this report page is not valid, or it expired. Open the report page again from Inflexa.";
const FONT = PAGE_ASSETS.find((asset) => asset.file.endsWith(".woff2"))!.file;
const SANDBOX = "sandbox allow-scripts allow-downloads";

let now = 1_000_000;
let grants: PageGrantStore;
let app: Hono<ServerEnv>;
let home = "";
let outside = "";
let root = "";

beforeEach(async () => {
    freshDb();
    invalidateWorkspaceRoot();
    now = 1_000_000;
    grants = createPageGrantStore(() => now);
    app = buildApp({ token: TOKEN, boot: idleBoot(), lifecycle: idleLifecycle(), pageGrants: grants });
    // realpath so the paths match the canonical paths of the route (macOS /var -> /private/var).
    home = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-report-pages-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-report-pages-outside-")));
    (await writeMarker(home, "A1"))._unsafeUnwrap();
    insertAnchor({ id: "A1", createdAt: 1, updatedAt: 1, cachedPath: home, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
    insertAnalysis({ id: "a1", createdAt: 1, updatedAt: 1, name: asStr256("A"), slug: "a", anchorId: "A1", projectId: null })._unsafeUnwrap();
    root = (await workspaceRootForAnalysisId("a1"))._unsafeUnwrap();
    sessionFile("t1", "index.html", "<html>page t1</html>");
    sessionFile("t1", "assets/fig.png", "png-bytes");
    sessionFile("t1", "assets/notes.csv", "a,b\n");
    sessionFile("t1", `assets/${FONT}`, "font-bytes");
    sessionFile("t1", "assets/deps/notes.csv", "guarded");
    sessionFile("t1", ".state", "hidden");
    sessionFile("t2", "assets/other.txt", "TOP-SECRET-T2");
});

afterEach(() => {
    releaseInstanceLock("a1");
    invalidateWorkspaceRoot();
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
});

/** Write a file of a report session and give its absolute path. */
function sessionFile(thread: string, rel: string, content: string): string {
    const abs = join(root, "report-sessions", thread, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
    return abs;
}

/** Mint a live grant for `a1` and `t1`, and give the `Cookie` header of a browser that did the entry request. */
function cookieFor(thread = "t1"): string {
    return `__ic=${grants.mint("a1", thread).token}`;
}

function page(path: string, init?: RequestInit): Promise<Response> | Response {
    return app.request(`/report-sessions/a1/t1/${path}`, init);
}

async function expectError(response: Response, status: number, code: ApiError["error"]): Promise<ApiError> {
    expect(response.status).toBe(status);
    // The error body of the app is an `ApiError`.
    const body = (await response.json()) as ApiError;
    expect(body.error).toBe(code);
    return body;
}

function expectSandbox(response: Response): void {
    expect(response.headers.get("Content-Security-Policy")).toBe(SANDBOX);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
}

describe("the entry request", () => {
    test("a live token serves the page and sets the cookie of the session", async () => {
        const { token } = grants.mint("a1", "t1");
        const response = await page(`index.html?t=${token}`);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("<html>page t1</html>");
        expect(response.headers.get("Set-Cookie")).toBe(`__ic=${token}; Path=/report-sessions/a1/t1/; HttpOnly; SameSite=Lax; Max-Age=900`);
        expect(response.headers.get("Set-Cookie")).not.toContain("Secure");
        expect(response.headers.get("Content-Type")).toStartWith("text/html");
    });

    test("the Max-Age is the whole seconds that the grant still lives, rounded down", async () => {
        const { token } = grants.mint("a1", "t1");
        now += 100_500;
        const response = await page(`index.html?t=${token}`);
        expect(response.headers.get("Set-Cookie")).toContain("Max-Age=799");
    });

    test("a token of a different session gives 401 with the exact message, and no cookie", async () => {
        const { token } = grants.mint("a1", "t1");
        const response = await app.request(`/report-sessions/a1/t2/index.html?t=${token}`);
        const body = await expectError(response, 401, "unauthorized");
        expect(body.message).toBe(UNAUTHORIZED_MESSAGE);
        expect(response.headers.get("Set-Cookie")).toBeNull();
    });

    test("an expired token gives 401, and no cookie", async () => {
        const { token } = grants.mint("a1", "t1");
        now += 900_001;
        const response = await page(`index.html?t=${token}`);
        await expectError(response, 401, "unauthorized");
        expect(response.headers.get("Set-Cookie")).toBeNull();
    });

    test("the query token wins: a bad token gives 401 even with a live cookie and for a public file", async () => {
        const cookie = cookieFor();
        await expectError(await page("index.html?t=nope", { headers: { Cookie: cookie } }), 401, "unauthorized");
        await expectError(await page(`assets/${FONT}?t=nope`), 401, "unauthorized");
    });
});

describe("the cookie and the public files", () => {
    test("an asset loads with the cookie and no token", async () => {
        const response = await page("assets/fig.png", { headers: { Cookie: cookieFor() } });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("png-bytes");
        expect(response.headers.get("Set-Cookie")).toBeNull();
        expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    test("an asset with no cookie gives 401 with the exact message", async () => {
        const body = await expectError(await page("assets/fig.png"), 401, "unauthorized");
        expect(body.message).toBe(UNAUTHORIZED_MESSAGE);
    });

    test("a cookie of a different session, an expired cookie, and a bad cookie give 401", async () => {
        await expectError(await page("assets/fig.png", { headers: { Cookie: cookieFor("t2") } }), 401, "unauthorized");
        await expectError(await page("assets/fig.png", { headers: { Cookie: "__ic=nope" } }), 401, "unauthorized");
        const cookie = cookieFor();
        now += 900_001;
        await expectError(await page("assets/fig.png", { headers: { Cookie: cookie } }), 401, "unauthorized");
    });

    test("a font of the manifest needs no token, and it has the CORS header", async () => {
        const response = await page(`assets/${FONT}`, { headers: { Origin: "null" } });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("font-bytes");
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
        expectSandbox(response);
    });

    test("a file under deps that the manifest does not carry needs a grant", async () => {
        await expectError(await page("assets/deps/notes.csv"), 401, "unauthorized");
        const response = await page("assets/deps/notes.csv", { headers: { Cookie: cookieFor() } });
        expect(response.status).toBe(200);
        expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    test("a public name outside `assets/` needs a grant", async () => {
        sessionFile("t1", FONT, "font-elsewhere");
        await expectError(await page(FONT), 401, "unauthorized");
    });

    test("the API credentials give no access", async () => {
        const cookie = await signIn(app, TOKEN);
        await expectError(await page("index.html", { headers: AUTH }), 401, "unauthorized");
        await expectError(await page("index.html", { headers: { Cookie: cookie } }), 401, "unauthorized");
    });
});

describe("the headers", () => {
    test("the page and a ranged answer run in a sandbox with no store", async () => {
        const cookie = cookieFor();
        const full = await page("index.html", { headers: { Cookie: cookie } });
        expect(full.status).toBe(200);
        expectSandbox(full);
        const ranged = await page("index.html", { headers: { Cookie: cookie, Range: "bytes=0-5" } });
        expect(ranged.status).toBe(206);
        expect(await ranged.text()).toBe("<html>");
        expectSandbox(ranged);
    });

    test("an error response carries the headers too", async () => {
        expectSandbox(await page("index.html"));
        expectSandbox(await page("missing.html", { headers: { Cookie: cookieFor() } }));
        expectSandbox(await page(".state"));
        expectSandbox(await app.request("/report-sessions/a1/t1/"));
    });

    test("a 304 keeps the sandbox, the referrer policy, and the cache policy", async () => {
        const cookie = cookieFor();
        const first = await page("assets/fig.png", { headers: { Cookie: cookie } });
        const etag = first.headers.get("ETag");
        expect(etag).not.toBeNull();
        const response = await page("assets/fig.png", { headers: { Cookie: cookie, "If-None-Match": etag! } });
        expect(response.status).toBe(304);
        expectSandbox(response);
    });

    test("a 304 of a public file keeps the CORS header", async () => {
        const first = await page(`assets/${FONT}`);
        const response = await page(`assets/${FONT}`, { headers: { "If-None-Match": first.headers.get("ETag")! } });
        expect(response.status).toBe(304);
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
        expectSandbox(response);
    });

    test("HEAD gives the status and the headers of GET, and no body", async () => {
        const cookie = cookieFor();
        const get = await page("assets/fig.png", { headers: { Cookie: cookie } });
        const head = await page("assets/fig.png", { method: "HEAD", headers: { Cookie: cookie } });
        expect(head.status).toBe(200);
        expect(head.headers.get("Content-Length")).toBe(get.headers.get("Content-Length"));
        expect(head.headers.get("ETag")).toBe(get.headers.get("ETag"));
        expectSandbox(head);
        expect(await head.text()).toBe("");
        const refused = await page("assets/fig.png", { method: "HEAD" });
        expect(refused.status).toBe(401);
        expectSandbox(refused);
    });

    test("HEAD of the entry request sets the cookie", async () => {
        const { token } = grants.mint("a1", "t1");
        const head = await page(`index.html?t=${token}`, { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(head.headers.get("Set-Cookie")).toContain(`__ic=${token}; Path=/report-sessions/a1/t1/`);
    });
});

describe("the form of the ids and of the path", () => {
    test("a hidden file gives 404, also without a grant", async () => {
        await expectError(await page(".state", { headers: { Cookie: cookieFor() } }), 404, "not_found");
        await expectError(await page(".state"), 404, "not_found");
        await expectError(await page("assets/.hidden/x.txt", { headers: { Cookie: cookieFor() } }), 404, "not_found");
    });

    test("an id with a separator, a NUL byte, or a bad escape gives 404 before the proof", async () => {
        for (const path of [
            "/report-sessions/a1%2Fx/t1/index.html",
            "/report-sessions/a1/t1%5Cx/index.html",
            "/report-sessions/a1/t1%00/index.html",
            "/report-sessions/a1/%E0%A4%A/index.html",
        ]) {
            await expectError(await app.request(path), 404, "not_found");
        }
    });

    test("a folder, the root of the session, and an absent file give 404", async () => {
        const headers = { Cookie: cookieFor() };
        await expectError(await page("assets", { headers }), 404, "not_found");
        await expectError(await page("assets/", { headers }), 404, "not_found");
        await expectError(await app.request("/report-sessions/a1/t1", { headers }), 404, "not_found");
        await expectError(await page("assets/absent.png", { headers }), 404, "not_found");
    });

    test("an encoded `..` in the path reaches no file outside the session", async () => {
        const headers = { Cookie: cookieFor() };
        const response = await page("assets%2F..%2F..%2Ft2%2Fassets%2Fother.txt", { headers });
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("TOP-SECRET-T2");
    });

    test("an unknown analysis and a lost workspace give 404", async () => {
        const { token } = grants.mint("ghost", "t1");
        await expectError(await app.request(`/report-sessions/ghost/t1/index.html?t=${token}`), 404, "not_found");
        const cookie = cookieFor();
        rmSync(home, { recursive: true, force: true });
        invalidateWorkspaceRoot();
        await expectError(await page("index.html", { headers: { Cookie: cookie } }), 404, "not_found");
    });

    test("a session with no folder gives 404", async () => {
        const { token } = grants.mint("a1", "t9");
        await expectError(await app.request(`/report-sessions/a1/t9/index.html?t=${token}`), 404, "not_found");
    });
});

describe("the confinement to the session folder", () => {
    test("a session folder that is a link gives 403 and no byte", async () => {
        sessionFile("real", "index.html", "TOP-SECRET-REAL");
        symlinkSync(join(root, "report-sessions", "real"), join(root, "report-sessions", "linked"));
        const response = await app.request("/report-sessions/a1/linked/index.html", { headers: { Cookie: cookieFor("linked") } });
        await expectError(response, 403, "forbidden");
        // The verdict of the folder comes before the file: a name that is absent gives 403 too, and no 404 that leaks the target.
        await expectError(await app.request("/report-sessions/a1/linked/absent.html", { headers: { Cookie: cookieFor("linked") } }), 403, "forbidden");
    });

    test("a session folder that is a link to a folder outside the workspace gives 403", async () => {
        writeFileSync(join(outside, "index.html"), "TOP-SECRET-OUTSIDE");
        symlinkSync(outside, join(root, "report-sessions", "away"));
        const response = await app.request("/report-sessions/a1/away/index.html", { headers: { Cookie: cookieFor("away") } });
        const body = await expectError(response, 403, "forbidden");
        expect(JSON.stringify(body)).not.toContain("TOP-SECRET");
    });

    test("a `report-sessions` folder that is a link gives 403", async () => {
        writeFileSync(join(outside, "index.html"), "TOP-SECRET-OUTSIDE");
        mkdirSync(join(outside, "t1"));
        writeFileSync(join(outside, "t1", "index.html"), "TOP-SECRET-OUTSIDE");
        rmSync(join(root, "report-sessions"), { recursive: true });
        symlinkSync(outside, join(root, "report-sessions"));
        await expectError(await page("index.html", { headers: { Cookie: cookieFor() } }), 403, "forbidden");
    });

    test("a link that leaves the session folder gives 403 and no byte of the target", async () => {
        writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");
        symlinkSync(join(outside, "secret.txt"), join(root, "report-sessions", "t1", "assets", "leak.txt"));
        const body = await expectError(await page("assets/leak.txt", { headers: { Cookie: cookieFor() } }), 403, "forbidden");
        expect(JSON.stringify(body)).not.toContain("TOP-SECRET");
    });

    test("a link to a file of a different session gives 403", async () => {
        symlinkSync(join(root, "report-sessions", "t2", "assets", "other.txt"), join(root, "report-sessions", "t1", "assets", "peer.txt"));
        const response = await page("assets/peer.txt", { headers: { Cookie: cookieFor() } });
        await expectError(response, 403, "forbidden");
    });

    test("a link to a folder of a different session gives 403 for a file under it", async () => {
        symlinkSync(join(root, "report-sessions", "t2"), join(root, "report-sessions", "t1", "assets", "peer"));
        await expectError(await page("assets/peer/assets/other.txt", { headers: { Cookie: cookieFor() } }), 403, "forbidden");
    });

    test("a link at a public path gives 403 and no byte of its target, with no grant", async () => {
        const publicPath = join(root, "report-sessions", "t1", "assets", FONT);
        rmSync(publicPath);
        symlinkSync(join(root, "report-sessions", "t1", "assets", "notes.csv"), publicPath);
        const response = await page(`assets/${FONT}`);
        expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
        const body = await expectError(response, 403, "forbidden");
        expect(JSON.stringify(body)).not.toContain("a,b");
    });

    test("the proof comes before the file: a link at a non-public path without a grant gives 401", async () => {
        symlinkSync(join(root, "report-sessions", "t1", "assets", "fig.png"), join(root, "report-sessions", "t1", "assets", "same.png"));
        await expectError(await page("assets/same.png"), 401, "unauthorized");
    });

    test.skipIf(process.getuid?.() === 0)("a session folder that cannot be read gives 500 and no path of the disk", async () => {
        const sessions = join(root, "report-sessions");
        chmodSync(sessions, 0o000);
        try {
            const response = await page("index.html", { headers: { Cookie: cookieFor() } });
            const body = await expectError(response, 500, "internal_error");
            expect(JSON.stringify(body)).not.toContain(root);
            expect(JSON.stringify(body)).not.toContain("EACCES");
            expectSandbox(response);
        } finally {
            chmodSync(sessions, 0o755);
        }
    });

    test("a link that stays inside the session folder serves its target", async () => {
        symlinkSync(join(root, "report-sessions", "t1", "assets", "fig.png"), join(root, "report-sessions", "t1", "assets", "same.png"));
        const response = await page("assets/same.png", { headers: { Cookie: cookieFor() } });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("png-bytes");
    });
});

describe("POST /api/v1/analyses/:analysisId/report-sessions/:threadId/access", () => {
    const access = (thread = "t1", headers: Record<string, string> = AUTH): Promise<Response> | Response =>
        app.request(`/api/v1/analyses/a1/report-sessions/${thread}/access`, { method: "POST", headers });

    test("a client gets the URL of the page and the expiry", async () => {
        const response = await access();
        expect(response.status).toBe(200);
        const body = (await response.json()) as ReportSessionAccess;
        expect(body.url).toStartWith("http://127.0.0.1:");
        expect(new URL(body.url).pathname).toBe("/report-sessions/a1/t1/index.html");
        expect(new URL(body.url).searchParams.get("t")).toMatch(/^[0-9a-f]{64}$/);
        expect(body.expiresAt).toBe(new Date(now + 900_000).toISOString());
    });

    test("the port of the listener that carried the request is in the URL", async () => {
        const response = await app.request(
            "/api/v1/analyses/a1/report-sessions/t1/access",
            { method: "POST", headers: { ...AUTH, Host: "127.0.0.1:9123" } },
            { port: 9123 },
        );
        expect(((await response.json()) as ReportSessionAccess).url).toStartWith("http://127.0.0.1:9123/report-sessions/a1/t1/index.html?t=");
    });

    test("the URL of the answer opens the page through the page route, and the cookie opens an asset", async () => {
        const body = (await (await access()).json()) as ReportSessionAccess;
        const url = new URL(body.url);
        const entry = await app.request(`${url.pathname}${url.search}`);
        expect(entry.status).toBe(200);
        expect(await entry.text()).toBe("<html>page t1</html>");
        const cookie = entry.headers.get("Set-Cookie")?.split(";")[0];
        expect(cookie).toStartWith("__ic=");
        const asset = await page("assets/fig.png", { headers: { Cookie: cookie! } });
        expect(asset.status).toBe(200);
        expect(await asset.text()).toBe("png-bytes");
    });

    test("the URL from the publisher factory opens the page through the same app", async () => {
        const publisher = createSessionPagePublisherFactory(grants, "http://127.0.0.1:8436")({ analysisId: "a1", auth: makeLocalAuth() });
        const minted = (await publisher.mintSessionPageAccess("t1"))._unsafeUnwrap();
        const entry = await app.request(`/report-sessions/a1/t1/index.html?t=${minted.token}`);
        expect(entry.status).toBe(200);
        expect(await entry.text()).toBe("<html>page t1</html>");
    });

    test("the session cookie of a browser sign-in gives the access too", async () => {
        const cookie = await signIn(app, TOKEN);
        expect((await access("t1", { Cookie: cookie })).status).toBe(200);
    });

    test("a request with no credential gives 401", async () => {
        await expectError(await access("t1", {}), 401, "unauthorized");
    });

    test("an unknown analysis gives 404 from the guard", async () => {
        const response = await app.request("/api/v1/analyses/nope/report-sessions/t1/access", { method: "POST", headers: AUTH });
        await expectError(response, 404, "not_found");
    });

    test("a thread id with a separator gives 400, and mints nothing", async () => {
        await expectError(await access("t%5C1"), 400, "validation_error");
        await expectError(await access("a%2Fb"), 400, "validation_error");
    });

    test("a session with no folder, no index.html, or a folder as index.html gives 404, and mints nothing", async () => {
        const minted: string[] = [];
        const counting: PageGrantStore = {
            mint: (analysisId, threadId) => {
                minted.push(`${analysisId}/${threadId}`);
                return grants.mint(analysisId, threadId);
            },
            remainingSeconds: grants.remainingSeconds,
        };
        app = buildApp({ token: TOKEN, boot: idleBoot(), lifecycle: idleLifecycle(), pageGrants: counting });
        mkdirSync(join(root, "report-sessions", "empty"), { recursive: true });
        mkdirSync(join(root, "report-sessions", "dir", "index.html"), { recursive: true });
        for (const thread of ["none", "empty", "dir"]) await expectError(await access(thread), 404, "not_found");
        expect(minted).toEqual([]);
        expect((await access()).status).toBe(200);
        expect(minted).toEqual(["a1/t1"]);
    });

    test("a session folder that is a link gives 404, and an index.html link out of the folder gives 404", async () => {
        symlinkSync(join(root, "report-sessions", "t1"), join(root, "report-sessions", "linked"));
        await expectError(await access("linked"), 404, "not_found");
        writeFileSync(join(outside, "index.html"), "x");
        mkdirSync(join(root, "report-sessions", "leaky"));
        symlinkSync(join(outside, "index.html"), join(root, "report-sessions", "leaky", "index.html"));
        await expectError(await access("leaky"), 404, "not_found");
    });

    test("a workspace that cannot be located gives 409 with the message of the workspace error", async () => {
        rmSync(home, { recursive: true, force: true });
        invalidateWorkspaceRoot();
        const body = await expectError(await access(), 409, "conflict");
        expect(body.message).toContain("cannot be located");
    });

    test("the fetcher sends the POST to the path and gives the body", async () => {
        const answer: ReportSessionAccess = { url: "http://127.0.0.1:1/report-sessions/a%201/t/index.html?t=x", expiresAt: "2026-10-20T00:00:00.000Z" };
        const { opts, requests } = fakeClient(() => ({ status: 200, body: answer }));
        const result = await mintReportSessionAccess("a 1", "t/1", opts);
        expect(result._unsafeUnwrap()).toEqual(answer);
        expect(requests).toEqual([{ method: "POST", path: "/api/v1/analyses/a%201/report-sessions/t%2F1/access", body: undefined }]);
    });
});
