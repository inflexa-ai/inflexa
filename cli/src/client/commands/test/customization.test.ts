import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { ok } from "neverthrow";

import { captureConsole } from "../../../test_support/console_capture.ts";
import { fakeClient } from "../../../test_support/fake_client.ts";
import { agentAttach, MCP_REPEAT_WARNING, mcpAdd, mcpAuth, type McpAuthOpts } from "../customization.ts";

const LIMS = {
    type: "stdio",
    command: "lims-mcp",
    args: ["--port", "1"],
    env: { TOKEN: "${cred:lims}" },
    approval: "always",
    scriptable: false,
    enabled: true,
};

describe("inflexa mcp add", () => {
    test("sends a local server entry, and prints the warning about repeated calls before the confirmation", async () => {
        const client = fakeClient(() => ({ status: 201, body: { name: "lims", entry: LIMS } }));

        const out = await captureConsole(() => mcpAdd("lims", ["lims-mcp", "--port", "1"], { env: ["TOKEN=${cred:lims}"] }, client.opts));

        expect(client.requests).toEqual([
            {
                method: "POST",
                path: "/api/v1/mcp",
                body: {
                    name: "lims",
                    entry: { type: "stdio", command: "lims-mcp", args: ["--port", "1"], env: { TOKEN: "${cred:lims}" }, scriptable: false, enabled: true },
                },
            },
        ]);
        const warning = out.stdout.indexOf(MCP_REPEAT_WARNING);
        expect(warning).toBeGreaterThanOrEqual(0);
        expect(out.stdout.indexOf('Added the MCP server "lims".')).toBeGreaterThan(warning);
        expect(MCP_REPEAT_WARNING).toContain("act two times");
    });

    test("sends an HTTP server entry with its headers and OAuth", async () => {
        const client = fakeClient(() => ({
            status: 201,
            body: {
                name: "remote",
                entry: { type: "http", url: "https://mcp.example", headers: {}, auth: "oauth", approval: "always", scriptable: false, enabled: true },
            },
        }));

        const out = await captureConsole(() => mcpAdd("remote", [], { url: "https://mcp.example", header: ["X-Team=a=b"], oauth: true }, client.opts));

        expect(client.requests[0]?.body).toEqual({
            name: "remote",
            entry: { type: "http", url: "https://mcp.example", headers: { "X-Team": "a=b" }, auth: "oauth", scriptable: false, enabled: true },
        });
        expect(out.stdout).toContain("inflexa mcp auth remote");
    });
});

describe("inflexa agent detach", () => {
    test("sends one change for each name, and prints the gaps one time, after the last name", async () => {
        const client = fakeClient(() => ({
            status: 200,
            body: { id: "analyst", gaps: [{ reason: "unknown_skill", reference: "x", message: "No skill x." }] },
        }));

        const out = await captureConsole(() => agentAttach("analyst", "skill", ["single-cell", "proteomics"], false, client.opts));

        expect(client.requests.map((request) => request.body)).toEqual([
            { detach: { kind: "skill", name: "single-cell" } },
            { detach: { kind: "skill", name: "proteomics" } },
        ]);
        expect(out.stdout).toContain('Detached the skill "single-cell" from "analyst".');
        expect(out.stdout).toContain('Detached the skill "proteomics" from "analyst".');
        expect(out.stdout.split("No skill x.").length - 1).toBe(1);
    });
});

describe("inflexa mcp auth", () => {
    test("prints the authorization URL and the port-forward over SSH, and sends a pasted callback to the callback port", async () => {
        const encoder = new TextEncoder();
        const pasted: string[] = [];
        let pastedOne: () => void = () => undefined;
        const delivered = new Promise<void>((resolvePromise) => {
            pastedOne = resolvePromise;
        });
        // The server of the test: the authorization frame, then the outcome once the paste reached the callback.
        const body = new ReadableStream<Uint8Array>({
            async start(controller) {
                controller.enqueue(encoder.encode(": open\n\n"));
                const authorize = { type: "authorize", url: "https://auth.example/authorize?client_id=c", callbackUrl: "http://127.0.0.1:43123/callback" };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(authorize)}\n\n`));
                await delivered;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "signed_in" })}\n\n`));
                controller.close();
            },
        });
        const input = new PassThrough();
        const lines: string[] = [];
        const opened: string[] = [];
        const opts: McpAuthOpts = {
            discover: () => ok({ baseUrl: "http://server.test", token: "t" }),
            fetch: () => Promise.resolve(new Response(body, { headers: { "Content-Type": "text/event-stream" } })),
            write: (line) => {
                lines.push(line);
                if (line.startsWith("If the browser cannot reach")) input.write("http://localhost:43123/callback?code=the-code\n");
            },
            open: (url) => {
                opened.push(url);
                return ok(undefined);
            },
            sshConnection: "10.0.0.5 51000 10.0.0.9 22",
            input,
            deliver: (url) => {
                pasted.push(url.toString());
                pastedOne();
                return Promise.resolve(ok(undefined));
            },
        };

        await mcpAuth("remote", opts);

        expect(opened).toEqual(["https://auth.example/authorize?client_id=c"]);
        expect(lines[0]).toContain("https://auth.example/authorize?client_id=c");
        expect(lines.join("\n")).toContain("ssh -N -L 43123:127.0.0.1:43123 ");
        expect(pasted).toEqual(["http://127.0.0.1:43123/callback?code=the-code"]);
        expect(lines.at(-1)).toBe('Signed in to "remote".');
    });
});
