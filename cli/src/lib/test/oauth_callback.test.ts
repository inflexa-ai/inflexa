import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { ok, type Result } from "neverthrow";

import { acceptPastedCallbacks, deliverCallback, pastedCallbackUrl } from "../oauth_callback.ts";

describe("pastedCallbackUrl", () => {
    test("a callback URL of the port becomes the same request to 127.0.0.1", () => {
        const url = pastedCallbackUrl("  http://localhost:1455/auth/callback?code=c1&state=s1\n", 1455)._unsafeUnwrap();
        expect(url.toString()).toBe("http://127.0.0.1:1455/auth/callback?code=c1&state=s1");
    });

    test("an error callback is sent too, so that the sign-in ends with the reason of the provider", () => {
        expect(pastedCallbackUrl("http://127.0.0.1:54545/callback?error=access_denied", 54545).isOk()).toBe(true);
    });

    test("text that is not the callback of this sign-in is refused with the reason", () => {
        expect(pastedCallbackUrl("the code is c1", 1455)._unsafeUnwrapErr()).toContain("not a URL");
        expect(pastedCallbackUrl("https://auth.openai.com/authorize?code=c1", 1455)._unsafeUnwrapErr()).toContain("does not point at the sign-in callback");
        expect(pastedCallbackUrl("http://evil.example:1455/auth/callback?code=c1", 1455)._unsafeUnwrapErr()).toContain("does not point at the sign-in callback");
        expect(pastedCallbackUrl("http://localhost:8085/auth/callback?code=c1", 1455)._unsafeUnwrapErr()).toContain("names port 8085");
        expect(pastedCallbackUrl("http://localhost:1455/auth/callback?state=s1", 1455)._unsafeUnwrapErr()).toContain("holds no `code`");
    });
});

describe("deliverCallback and acceptPastedCallbacks", () => {
    const servers: { stop: () => Promise<void> }[] = [];
    afterEach(async () => {
        for (const server of servers.splice(0)) await server.stop();
    });

    /** A callback listener like the vendor's: it records the request, and redirects to its page of success. */
    function listener(): { port: number; seen: string[] } {
        const seen: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request) => {
                const url = new URL(request.url);
                seen.push(`${url.pathname}${url.search}`);
                return url.searchParams.has("code") ? Response.redirect("/success", 302) : new Response("No authorization code received", { status: 400 });
            },
        });
        servers.push({ stop: () => server.stop() });
        return { port: server.port ?? 0, seen };
    }

    test("a delivery that the listener takes is ok, and a refusal carries the status and the body", async () => {
        const { port, seen } = listener();
        expect((await deliverCallback(new URL(`http://127.0.0.1:${port}/auth/callback?code=c1&state=s1`))).isOk()).toBe(true);
        expect(seen).toEqual(["/auth/callback?code=c1&state=s1"]);
        expect((await deliverCallback(new URL(`http://127.0.0.1:${port}/auth/callback?error=x`)))._unsafeUnwrapErr()).toBe(
            "the sign-in refused the callback (HTTP 400): No authorization code received",
        );
    });

    test("a port with no listener names the port", async () => {
        const { port } = listener();
        await servers.splice(0)[0]?.stop();
        expect((await deliverCallback(new URL(`http://127.0.0.1:${port}/auth/callback?code=c1`)))._unsafeUnwrapErr()).toContain(`nothing answered on port ${port}`);
    });

    test("a pasted line reaches the listener, a bad line is refused, and the stop ends the read", async () => {
        const { port, seen } = listener();
        const input = new PassThrough();
        const said: string[] = [];
        const delivered: Promise<Result<void, string>>[] = [];
        const stop = acceptPastedCallbacks(port, {
            input,
            say: (line) => said.push(line),
            deliver: (url) => {
                const result = deliverCallback(url);
                delivered.push(result);
                return result;
            },
        });
        input.write(`http://localhost:${port}/auth/callback?code=c1&state=s1\n`);
        input.write("\n");
        input.write("not a url\n");
        await Promise.sleep(20);
        await Promise.all(delivered);
        stop();
        input.write(`http://localhost:${port}/auth/callback?code=c2\n`);
        await Promise.sleep(20);

        expect(seen).toEqual(["/auth/callback?code=c1&state=s1"]);
        expect(said).toEqual([
            "Not sent: the text is not a URL. Paste the full URL from the address bar of the browser.",
            "The callback reached the sign-in on this machine.",
        ]);
        expect(delivered).toHaveLength(1);
        expect(await delivered[0]).toEqual(ok(undefined));
    });
});
