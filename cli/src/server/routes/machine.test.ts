import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { err, ok } from "neverthrow";

import {
    EMBEDDING_API_KEY_HEADER,
    type AgentList,
    type EmbeddingModelList,
    type MeView,
    type ModelList,
    type PutAgentResponse,
    type ServerSettings,
} from "../../api/machine.ts";
import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { DEFAULT_MACHINE_ROUTE_OPTS, machineRoutes, type MachineRouteOpts } from "./machine.ts";

// The routes alone, with no app and no bearer check: `app.test.ts` covers those. The connection reads are
// stubs, thus no route here reaches a proxy or an endpoint. Each `as` cast of a body reads JSON that the
// route under test builds from the same `src/api/` type.

function routesWith(over: Partial<MachineRouteOpts> = {}): ReturnType<typeof machineRoutes> {
    return machineRoutes({ ...DEFAULT_MACHINE_ROUTE_OPTS, ...over });
}

function json(method: string, body: unknown): RequestInit {
    return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** The config file as written, read raw so the assertion names each key that is present. */
function persistedConfig(): Record<string, unknown> {
    // The route writes validated JSON; the cast reads it back for the assertion.
    return JSON.parse(readFileSync(env.configPath, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
    assertTestSandbox(env.configPath);
    mkdirSync(dirname(env.configPath), { recursive: true });
    writeFileSync(env.configPath, JSON.stringify({ telemetry: false }));
});

afterEach(() => {
    rmSync(env.configPath, { force: true });
    rmSync(env.authPath, { force: true });
});

describe("GET /api/v1/me", () => {
    test("a machine with no stored session is signed out, with the remedy", async () => {
        const me = (await (await routesWith().request("/me")).json()) as MeView;
        expect(me).toEqual({ signedIn: false, error: "Not logged in — run `inflexa auth login`." });
    });

    test("a stored session gives the claims of its ID token and the expiry", async () => {
        assertTestSandbox(env.authPath);
        const claims = Buffer.from(JSON.stringify({ sub: "auth0|1", email: "ada@example.com", name: "Ada" })).toString("base64url");
        mkdirSync(dirname(env.authPath), { recursive: true });
        writeFileSync(env.authPath, JSON.stringify({ accessToken: "a", refreshToken: "r", idToken: `h.${claims}.s`, expiresAt: "2030-01-01T00:00:00.000Z" }));

        const me = (await (await routesWith().request("/me")).json()) as MeView;
        expect(me).toEqual({
            signedIn: true,
            name: "Ada",
            email: "ada@example.com",
            subject: "auth0|1",
            claimsDecoded: true,
            expiresAt: "2030-01-01T00:00:00.000Z",
        });
    });
});

describe("the agents", () => {
    test("GET /api/v1/agents: no runtime gives each role with no current selection", async () => {
        const list = (await (await routesWith().request("/agents")).json()) as AgentList;
        expect(list.agents).toEqual([
            { role: "conversation", current: null, pending: null },
            { role: "sandbox", current: null, pending: null },
            { role: "utility", current: null, pending: null },
        ]);
    });

    test("PUT /api/v1/agents/:role saves the model and the effort in one config write", async () => {
        const checked: string[] = [];
        const routes = routesWith({
            validateModel: async (model) => {
                checked.push(model);
                return "served";
            },
        });

        const response = await routes.request("/agents/sandbox", json("PUT", { model: " claude-haiku-4-5 ", effort: "low" }));

        expect(response.status).toBe(200);
        // With no runtime the switch waits: the next boot reads the config.
        expect(((await response.json()) as PutAgentResponse).status).toBe("scheduled");
        expect(checked).toEqual(["claude-haiku-4-5"]);
        expect(persistedConfig()["models"]).toEqual({ agents: { sandbox: "claude-haiku-4-5" }, efforts: { sandbox: "low" } });
    });

    test("a model that the account cannot serve is 400 `validation_error` that names it, and nothing is written", async () => {
        const response = await routesWith({ validateModel: async () => "not_found" }).request(
            "/agents/conversation",
            json("PUT", { model: "claude-nope", effort: "high" }),
        );

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
            error: "validation_error",
            message: "This account cannot serve claude-nope. Pick another model, or check your credential.",
        });
        expect(persistedConfig()["models"]).toBeUndefined();
    });

    test("an inconclusive check accepts the pick", async () => {
        const response = await routesWith({ validateModel: async () => "inconclusive" }).request(
            "/agents/utility",
            json("PUT", { model: "m", effort: "medium" }),
        );
        expect(response.status).toBe(200);
    });

    test("an unknown role is 404, and an effort off the ladder is 400", async () => {
        const routes = routesWith({ validateModel: async () => "served" });
        expect((await routes.request("/agents/planner", json("PUT", { model: "m", effort: "high" }))).status).toBe(404);
        const bad = await routes.request("/agents/sandbox", json("PUT", { model: "m", effort: "max" }));
        expect(bad.status).toBe(400);
        expect(await bad.json()).toMatchObject({ error: "validation_error" });
    });
});

describe("GET /api/v1/models", () => {
    test("gives the models of the connection with their efforts", async () => {
        const routes = routesWith({ listModels: async () => ok([{ id: "claude-opus-4-8", efforts: ["low", "high"] }]) });
        expect((await (await routes.request("/models")).json()) as ModelList).toEqual({ models: [{ id: "claude-opus-4-8", efforts: ["low", "high"] }] });
    });

    test("a listing that failed is `models: null`, not an error", async () => {
        const routes = routesWith({ listModels: async () => err({ type: "key_missing" }) });
        const response = await routes.request("/models");
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ models: null });
    });
});

describe("the settings", () => {
    test("GET gives the server keys with the Postgres connection resolved and the embedding defaults", async () => {
        const settings = (await (await routesWith().request("/settings")).json()) as ServerSettings;
        expect(settings).toMatchObject({
            telemetry: false,
            runtime: null,
            postgres: { host: "localhost", port: env.postgresPort, database: "inflexa", user: "inflexa", passwordSet: false },
            embedding: { mode: "off", apiKeySet: false },
            embeddingDefaults: { apiBaseUrl: "https://api.openai.com/v1", apiDimensions: 1536, localDimensions: 384, builtinModelPath: env.embeddingModelPath },
        });
    });

    test("PATCH writes the keys it names, drops the Postgres fields at their defaults, and keeps the client keys", async () => {
        writeFileSync(env.configPath, JSON.stringify({ telemetry: false, theme: "github-light" }));
        const response = await routesWith().request(
            "/settings",
            json("PATCH", {
                telemetry: true,
                postgres: { host: "localhost", port: 9999, database: "inflexa", user: "me", password: "inflexa" },
                embedding: { mode: "api-key", apiKey: "sk-1" },
            }),
        );

        expect(response.status).toBe(200);
        expect(((await response.json()) as ServerSettings).telemetry).toBe(true);
        const config = persistedConfig();
        expect(config["theme"]).toBe("github-light");
        expect(config["postgres"]).toEqual({ port: 9999, user: "me" });
        expect(config["embedding"]).toEqual({ mode: "api-key", apiKey: "sk-1" });
    });

    test("GET sends no secret: the embedding API key and the Postgres password stay on the server", async () => {
        writeFileSync(
            env.configPath,
            JSON.stringify({ telemetry: false, postgres: { password: "pg-secret-1" }, embedding: { mode: "api-key", apiKey: "sk-secret-1" } }),
        );
        const body = await (await routesWith().request("/settings")).text();
        expect(["sk-secret-1", "pg-secret-1"].filter((secret) => body.includes(secret))).toEqual([]);
        expect(JSON.parse(body)).toMatchObject({ postgres: { passwordSet: true }, embedding: { mode: "api-key", apiKeySet: true } });
    });

    test("PATCH with no password and an `api-key` block with no key keeps each stored secret", async () => {
        writeFileSync(
            env.configPath,
            JSON.stringify({ telemetry: false, postgres: { password: "pg-secret-1" }, embedding: { mode: "api-key", apiKey: "sk-secret-1" } }),
        );
        const response = await routesWith().request(
            "/settings",
            json("PATCH", {
                postgres: { host: "db.example", port: 9999, database: "inflexa", user: "inflexa" },
                embedding: { mode: "api-key", model: "text-embedding-3-large" },
            }),
        );

        expect(response.status).toBe(200);
        const config = persistedConfig();
        expect(config["postgres"]).toEqual({ host: "db.example", port: 9999, password: "pg-secret-1" });
        expect(config["embedding"]).toEqual({ mode: "api-key", apiKey: "sk-secret-1", model: "text-embedding-3-large" });
    });

    test("PATCH refuses an `api-key` block with no key when the config holds none, with 400", async () => {
        const response = await routesWith().request("/settings", json("PATCH", { embedding: { mode: "api-key" } }));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "validation_error", details: { fieldErrors: { embedding: [expect.any(String)] } } });
        expect(persistedConfig()["embedding"]).toBeUndefined();
    });

    test("PATCH accepts the default port of this channel, which the GET gives, and pins no port", async () => {
        const response = await routesWith().request(
            "/settings",
            json("PATCH", { postgres: { host: "localhost", port: env.postgresPort, database: "inflexa", user: "me" } }),
        );
        expect(response.status).toBe(200);
        expect(persistedConfig()["postgres"]).toEqual({ user: "me" });
    });

    test("PATCH refuses a reserved Postgres port with 400", async () => {
        const response = await routesWith().request(
            "/settings",
            json("PATCH", { postgres: { host: "localhost", port: 8432, database: "inflexa", user: "inflexa", password: "inflexa" } }),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "validation_error" });
    });
});

describe("GET /api/v1/embedding-models", () => {
    test("lists the models of the endpoint with the key of the header", async () => {
        const seen: string[] = [];
        const routes = routesWith({
            listEmbeddingModels: async (baseUrl, apiKey) => {
                seen.push(`${baseUrl} ${apiKey}`);
                return ok(["text-embedding-3-small"]);
            },
        });
        const response = await routes.request(`/embedding-models?baseUrl=${encodeURIComponent("https://e.example/v1")}`, {
            headers: { [EMBEDDING_API_KEY_HEADER]: "sk-1" },
        });
        expect((await response.json()) as EmbeddingModelList).toEqual({ models: ["text-embedding-3-small"] });
        expect(seen).toEqual(["https://e.example/v1 sk-1"]);
    });

    test("a listing failure is `models: null` with the reason, and a request with no key is 400", async () => {
        const routes = routesWith({ listEmbeddingModels: async () => err({ type: "http_error", status: 401 }) });
        const failed = await routes.request("/embedding-models", { headers: { [EMBEDDING_API_KEY_HEADER]: "sk-1" } });
        expect(await failed.json()).toEqual({ models: null, reason: "http_error" });
        expect((await routes.request("/embedding-models")).status).toBe(400);
    });
});
