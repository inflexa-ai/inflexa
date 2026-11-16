import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";

import { customizationFixture, writeAgentFile, writeSkill, type CustomizationFixture } from "../../../test_support/customization.ts";
import { errorBody, jsonBody } from "../../../test_support/response_body.ts";
import { createCustomizationService } from "../../../modules/customization/service.ts";
import { customizationRoutes } from "../customization.ts";

// The routes alone, with no app and no bearer check: `app.test.ts` covers those. Each test has its own directories
// and its own config in memory.
let fixture: CustomizationFixture;
let routes: ReturnType<typeof customizationRoutes>;

beforeEach(() => {
    fixture = customizationFixture();
    routes = customizationRoutes(createCustomizationService(fixture.opts));
});

function send(method: string, path: string, body?: unknown): Promise<Response> {
    const init: RequestInit = body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    return Promise.resolve(routes.request(path, init));
}

const agentListBody = z.object({ agents: z.array(z.looseObject({ id: z.string(), kind: z.string(), draft: z.boolean() })) });

describe("/catalog/agents", () => {
    test("GET lists the built-in agents and each draft", async () => {
        writeAgentFile(fixture, "broken", "---\nname: other\ndescription: Broken.\n---\nThe prompt.\n");

        const response = await send("GET", "/catalog/agents");

        expect(response.status).toBe(200);
        const { agents } = agentListBody.parse(await jsonBody(response));
        expect(agents.find((agent) => agent.id === "analyst")).toMatchObject({ kind: "builtin", draft: false });
        expect(agents.find((agent) => agent.id === "broken")).toMatchObject({ kind: "custom", draft: true });
    });

    test("GET of an unknown id is 404 `not_found`", async () => {
        const response = await send("GET", "/catalog/agents/nope");
        expect(response.status).toBe(404);
        expect(await errorBody(response)).toMatchObject({ error: "not_found" });
    });

    test("PATCH with a prompt of a built-in agent is 403, and the reason says that the prompt is read-only", async () => {
        const response = await send("PATCH", "/catalog/agents/analyst", { prompt: "Do something else." });

        expect(response.status).toBe(403);
        expect((await errorBody(response)).message).toContain("is read-only");
        expect(fixture.config.agents).toBeUndefined();
    });

    test("PATCH attaches a skill, and turns off an agent that can be off", async () => {
        writeSkill(fixture.userSkillsDir, "lab-protocols");

        const attached = await send("PATCH", "/catalog/agents/analyst", { attach: { kind: "skill", name: "lab-protocols" } });
        expect(attached.status).toBe(200);
        expect(fixture.config.agents).toEqual({ analyst: { add: { skills: ["lab-protocols"] } } });

        const off = await send("PATCH", "/catalog/agents/drug-analyst", { enabled: false });
        expect(off.status).toBe(200);
        expect(await jsonBody(off)).toMatchObject({ id: "drug-analyst", enabled: false });
    });

    test("PATCH that turns off an agent that must stay on is 403 `forbidden`", async () => {
        const response = await send("PATCH", "/catalog/agents/analyst", { enabled: false });
        expect(response.status).toBe(403);
        expect(await errorBody(response)).toMatchObject({ error: "forbidden" });
    });

    test("POST clone is 201, and a second clone with the same id is 409 `conflict`", async () => {
        const first = await send("POST", "/catalog/agents/analyst/clone", { newId: "my-analyst" });
        expect(first.status).toBe(201);
        expect(await jsonBody(first)).toMatchObject({ id: "my-analyst", kind: "custom", path: join(fixture.agentsDir, "my-analyst.md") });

        const second = await send("POST", "/catalog/agents/analyst/clone", { newId: "my-analyst" });
        expect(second.status).toBe(409);
    });

    test("POST import of a file that does not exist is 400 `validation_error`", async () => {
        const response = await send("POST", "/catalog/agents/import", { path: join(fixture.root, "absent.md") });
        expect(response.status).toBe(400);
        expect(await errorBody(response)).toMatchObject({ error: "validation_error" });
    });

    test("DELETE removes a custom agent, and refuses a built-in agent", async () => {
        writeAgentFile(fixture, "mine", "---\nname: mine\ndescription: Mine.\n---\nThe prompt.\n");

        expect(await jsonBody(send("DELETE", "/catalog/agents/mine"))).toEqual({ deleted: true });
        expect((await send("DELETE", "/catalog/agents/analyst")).status).toBe(403);
    });
});

describe("/skills", () => {
    test("GET lists the skills, GET with `dir` finds the skills of a directory, and POST import copies one", async () => {
        const source = writeSkill(join(fixture.root, "found"), "plate-reader");

        const listed = z.object({ skills: z.array(z.looseObject({ name: z.string() })) }).parse(await jsonBody(send("GET", "/skills")));
        expect(listed.skills.map((skill) => skill.name)).toEqual(["omics-general", "single-cell"]);

        const found = await jsonBody(send("GET", `/skills?dir=${encodeURIComponent(join(fixture.root, "found"))}`));
        expect(found).toMatchObject({ skills: [{ name: "plate-reader", kind: "found" }] });

        const imported = await send("POST", "/skills/import", { path: source });
        expect(imported.status).toBe(201);
        expect((await send("POST", "/skills/import", { path: source })).status).toBe(409);
    });
});

describe("/connectors and /credentials", () => {
    test("PATCH a connector, PUT a credential, and GET both lists", async () => {
        const patched = await send("PATCH", "/connectors/pubmed", { credentials: { ncbi: "ncbi-key" } });
        expect(patched.status).toBe(200);

        const put = await send("PUT", "/credentials/ncbi-key", { kind: "env", var: "INFLEXA_TEST_ROUTE_ABSENT_VAR" });
        expect(await jsonBody(put)).toEqual({ name: "ncbi-key", source: { kind: "env", var: "INFLEXA_TEST_ROUTE_ABSENT_VAR" }, resolves: false });

        expect(await jsonBody(send("GET", "/credentials"))).toEqual({
            credentials: [{ name: "ncbi-key", source: { kind: "env", var: "INFLEXA_TEST_ROUTE_ABSENT_VAR" }, resolves: false }],
        });
        const connectors = z.object({ connectors: z.array(z.looseObject({ id: z.string(), slots: z.array(z.looseObject({ credential: z.string() })) })) });
        const pubmed = connectors.parse(await jsonBody(send("GET", "/connectors"))).connectors.find((connector) => connector.id === "pubmed");
        expect(pubmed?.slots.map((slot) => slot.credential)).toEqual(["ncbi-key"]);
    });

    test("an unknown connector is 404, and a credential source with no kind is 400", async () => {
        expect((await send("PATCH", "/connectors/nope", {})).status).toBe(404);
        expect((await send("PUT", "/credentials/x", { var: "X" })).status).toBe(400);
    });
});

describe("/mcp", () => {
    test("POST adds a server, a bad name is 400 with the name rule, and a taken name is 409", async () => {
        const bad = await send("POST", "/mcp", { name: "lab.lims", entry: { type: "stdio", command: "lims-mcp" } });
        expect(bad.status).toBe(400);
        expect((await errorBody(bad)).message).toContain("lowercase letters, digits, and hyphens");

        const added = await send("POST", "/mcp", { name: "lims", entry: { type: "stdio", command: "lims-mcp" } });
        expect(added.status).toBe(201);
        expect((await send("POST", "/mcp", { name: "lims", entry: { type: "stdio", command: "lims-mcp" } })).status).toBe(409);
    });

    test("PATCH turns a server off, GET lists it, and DELETE removes it", async () => {
        await send("POST", "/mcp", { name: "lims", entry: { type: "stdio", command: "lims-mcp" } });

        expect(await jsonBody(send("PATCH", "/mcp/lims", { enabled: false }))).toMatchObject({ name: "lims", entry: { enabled: false } });
        expect(await jsonBody(send("GET", "/mcp"))).toMatchObject({ servers: [{ name: "lims" }] });
        expect(await jsonBody(send("DELETE", "/mcp/lims"))).toEqual({ deleted: true });
        expect((await send("DELETE", "/mcp/lims")).status).toBe(404);
    });

    test("auth and logout of a server with no OAuth are 400, and logout of an OAuth server deletes its tokens", async () => {
        await send("POST", "/mcp", { name: "lims", entry: { type: "stdio", command: "lims-mcp" } });
        await send("POST", "/mcp", { name: "remote", entry: { type: "http", url: "https://mcp.example/mcp", auth: "oauth" } });
        await fixture.tokenStore.write("https://mcp.example/mcp", { tokens: { access_token: "a", token_type: "Bearer" } });

        expect((await send("POST", "/mcp/lims/auth")).status).toBe(400);
        expect((await send("DELETE", "/mcp/lims/auth")).status).toBe(400);
        expect(await jsonBody(send("DELETE", "/mcp/remote/auth"))).toEqual({ signedIn: false, revocation: { status: "no_endpoint" } });
        expect(await fixture.tokenStore.read("https://mcp.example/mcp")).toBeUndefined();
    });
});
