import { describe, expect, test } from "bun:test";

import { captureConsole } from "../../../test_support/console_capture.ts";
import { fakeClient } from "../../../test_support/fake_client.ts";
import { MCP_REPEAT_WARNING, mcpAdd } from "../customization.ts";

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
