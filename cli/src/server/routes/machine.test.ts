import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { err, ok } from "neverthrow";

import {
    EMBEDDING_API_KEY_HEADER,
    type AgentList,
    type EmbeddingModelList,
    type MachineSandboxReadiness,
    type MeView,
    type ModelList,
    type OpenFolderResult,
    type PutAgentResponse,
    type ServerSettings,
} from "../../api/machine.ts";
import type { ApiError } from "../../api/common.ts";
import { insertAnalysis, insertAnchor } from "../../db/primary_mutation.ts";
import { env } from "../../lib/env.ts";
import { asStr256 } from "../../lib/types.ts";
import { defaultOutputSubdir } from "../../modules/analysis/output.ts";
import type { OpenExternalError } from "../../lib/open_external.ts";
import { writeMarker } from "../../modules/anchor/marker.ts";
import { freshDb } from "../../test_support/db.ts";
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
    test("gives the models of the connection with their efforts and their release date", async () => {
        const routes = routesWith({
            listModels: async () =>
                ok([
                    { id: "claude-opus-5-5", efforts: ["low", "high"], releasedAt: "2026-09-21T00:00:00.000Z" },
                    { id: "claude-opus-4-8", efforts: ["low"], releasedAt: null },
                ]),
        });
        expect((await (await routes.request("/models")).json()) as ModelList).toEqual({
            models: [
                { id: "claude-opus-5-5", efforts: ["low", "high"], releasedAt: "2026-09-21T00:00:00.000Z" },
                { id: "claude-opus-4-8", efforts: ["low"], releasedAt: null },
            ],
        });
    });

    test("a listing that failed is `models: null` with the reason for a person, not an error", async () => {
        const routes = routesWith({ listModels: async () => err({ type: "timed_out", afterMs: 10_000 }) });
        const response = await routes.request("/models");
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ models: null, reason: "the model endpoint gave no answer within 10 s" });
    });

    // Bun 1.4.0 checks the idle timeout on a tick of about 4 s, thus a 1 s timeout closes a quiet request within
    // about 4 s, and a handler of 5.5 s outlives it. The control routes pin the two sides: a quiet GET closes, and
    // a request with a body stays open, which is why only a route with no body calls `holdConnection`.
    test("over a real listener, a listing slower than the idle timeout of Bun.serve still gets its response", async () => {
        const slowMs = 5_500;
        const app = routesWith({
            listModels: async () => {
                await Promise.sleep(slowMs);
                return ok([{ id: "claude-opus-4-8", efforts: ["low"], releasedAt: null }]);
            },
        });
        app.get("/quiet-control", async (c) => {
            await Promise.sleep(slowMs);
            return c.text("answered");
        });
        app.post("/body-control", async (c) => {
            await c.req.json();
            await Promise.sleep(slowMs);
            return c.text("answered");
        });
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 1, fetch: app.fetch });
        const outcome = (path: string, init?: RequestInit): Promise<string> =>
            fetch(`http://127.0.0.1:${server.port}${path}`, init).then(
                async (response) => `${response.status} ${await response.text()}`,
                (cause: unknown) => `failed: ${String(cause)}`,
            );
        try {
            const [models, quiet, withBody] = await Promise.all([outcome("/models"), outcome("/quiet-control"), outcome("/body-control", json("POST", {}))]);
            expect(models).toBe(`200 ${JSON.stringify({ models: [{ id: "claude-opus-4-8", efforts: ["low"], releasedAt: null }] })}`);
            expect(quiet).toContain("The socket connection was closed unexpectedly");
            expect(withBody).toBe("200 answered");
        } finally {
            await server.stop(true);
        }
    }, 15_000);
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

    test("GET gives the data folder and the server log as absolute paths", async () => {
        const settings = (await (await routesWith().request("/settings")).json()) as ServerSettings;
        // The database file sits directly in the data folder, and the server log sits in the log folder.
        expect(settings.dataDir).toBe(dirname(env.dbPath));
        expect(settings.serverLogPath).toBe(env.serverLogPath);
        expect(dirname(settings.serverLogPath)).toBe(env.logDir);
        expect(basename(settings.serverLogPath)).toMatch(/^server(\.dev)?\.log$/);
        expect(isAbsolute(settings.dataDir)).toBe(true);
        expect(isAbsolute(settings.serverLogPath)).toBe(true);
    });

    test("PATCH with a `dataDir` key saves the other keys and keeps the same `dataDir`", async () => {
        const response = await routesWith().request("/settings", json("PATCH", { telemetry: true, dataDir: "/tmp/x", serverLogPath: "/tmp/x/log" }));
        expect(response.status).toBe(200);
        const settings = (await response.json()) as ServerSettings;
        expect(settings).toMatchObject({ telemetry: true, dataDir: env.dataDir, serverLogPath: env.serverLogPath });
        expect(persistedConfig()).toMatchObject({ telemetry: true });
        expect(persistedConfig()).not.toHaveProperty("dataDir");
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

describe("GET /api/v1/sandbox", () => {
    test("gives the replaced read of the machine as it is", async () => {
        const machine: MachineSandboxReadiness = {
            image: { state: "absent", image: "ghcr.io/inflexa-ai/sandbox-base:latest" },
            store: "installed",
            catalogFarmPresent: false,
        };
        const response = await routesWith({ sandboxReadiness: () => Promise.resolve(machine) }).request("/sandbox");
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(machine);
    });

    test("an engine that does not answer is a 200 body with `image.state` `engine_error`", async () => {
        const machine: MachineSandboxReadiness = {
            image: { state: "engine_error", image: "sandbox:dev", message: "The container engine is not reachable (boom)." },
            store: "missing",
            catalogFarmPresent: false,
        };
        const response = await routesWith({ sandboxReadiness: () => Promise.resolve(machine) }).request("/sandbox");
        expect(response.status).toBe(200);
        expect(((await response.json()) as MachineSandboxReadiness).image).toEqual(machine.image);
    });
});

describe("POST /api/v1/open", () => {
    const homes: string[] = [];

    /** The routes with an opener that records each target, so no test starts a real opener. */
    function opener(failure: OpenExternalError | null = null): { routes: ReturnType<typeof machineRoutes>; opened: string[] } {
        const opened: string[] = [];
        const routes = routesWith({
            openExternal: (target) => {
                opened.push(target);
                return failure === null ? ok(undefined) : err(failure);
            },
        });
        return { routes, opened };
    }

    async function seedAnalysis(): Promise<{ id: string; home: string }> {
        const home = mkdtempSync(join(tmpdir(), "inflexa-open-"));
        homes.push(home);
        const anchorId = randomUUIDv7();
        (await writeMarker(home, anchorId))._unsafeUnwrap();
        insertAnchor({ id: anchorId, createdAt: 1, updatedAt: 1, cachedPath: home, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        const analysis = insertAnalysis({
            id: randomUUIDv7(),
            createdAt: 1,
            updatedAt: 1,
            name: asStr256("Alpha"),
            slug: "alpha",
            anchorId,
            projectId: null,
        })._unsafeUnwrap();
        return { id: analysis.id, home };
    }

    beforeEach(() => {
        freshDb();
    });

    afterEach(() => {
        for (const home of homes) rmSync(home, { recursive: true, force: true });
        homes.length = 0;
    });

    test("`data_dir` opens the data folder and answers `opened: true`", async () => {
        const { routes, opened } = opener();
        const response = await routes.request("/open", json("POST", { target: "data_dir" }));
        expect(response.status).toBe(200);
        expect((await response.json()) as OpenFolderResult).toEqual({ opened: true });
        expect(opened).toEqual([env.dataDir]);
    });

    test("`output_dir` for an analysis with no output folder makes the folder, opens it, and answers `opened: true`", async () => {
        const { id, home } = await seedAnalysis();
        const folder = join(home, defaultOutputSubdir("alpha"));
        expect(existsSync(folder)).toBe(false);

        const { routes, opened } = opener();
        const response = await routes.request("/open", json("POST", { target: "output_dir", analysisId: id }));
        expect(response.status).toBe(200);
        expect((await response.json()) as OpenFolderResult).toEqual({ opened: true });
        expect(existsSync(folder)).toBe(true);
        expect(opened).toEqual([folder]);
    });

    test("`output_dir` with no `analysisId` is 400 `validation_error`, and opens nothing", async () => {
        const { routes, opened } = opener();
        const response = await routes.request("/open", json("POST", { target: "output_dir" }));
        expect(response.status).toBe(400);
        expect(((await response.json()) as ApiError).error).toBe("validation_error");
        expect(opened).toEqual([]);
    });

    test("a path in place of a target is 400 `validation_error`, and opens nothing", async () => {
        const { routes, opened } = opener();
        const response = await routes.request("/open", json("POST", { target: "/etc" }));
        expect(response.status).toBe(400);
        expect(((await response.json()) as ApiError).error).toBe("validation_error");
        expect(opened).toEqual([]);
    });

    test("an unknown `analysisId` is 404 `not_found`, and opens nothing", async () => {
        await seedAnalysis();
        const { routes, opened } = opener();
        const response = await routes.request("/open", json("POST", { target: "output_dir", analysisId: "nope" }));
        expect(response.status).toBe(404);
        expect(((await response.json()) as ApiError).error).toBe("not_found");
        expect(opened).toEqual([]);
    });

    test("a name of an analysis in place of its id is 404 `not_found`, and opens nothing", async () => {
        await seedAnalysis();
        const { routes, opened } = opener();
        const response = await routes.request("/open", json("POST", { target: "output_dir", analysisId: "Alpha" }));
        expect(response.status).toBe(404);
        expect(((await response.json()) as ApiError).error).toBe("not_found");
        expect(opened).toEqual([]);
    });

    test("an analysis whose anchor folder was deleted is 409 `conflict`, and opens nothing", async () => {
        const { id, home } = await seedAnalysis();
        rmSync(home, { recursive: true, force: true });
        const { routes, opened } = opener();
        const response = await routes.request("/open", json("POST", { target: "output_dir", analysisId: id }));
        expect(response.status).toBe(409);
        expect(((await response.json()) as ApiError).error).toBe("conflict");
        expect(opened).toEqual([]);
    });

    test("a make of the output folder that fails is 500 `internal_error`, and opens nothing", async () => {
        const { id, home } = await seedAnalysis();
        // A file where the `analyses` folder belongs makes the `mkdir -p` of the output folder fail.
        writeFileSync(join(home, ".inflexa", "analyses"), "not a folder");
        const { routes, opened } = opener();
        const response = await routes.request("/open", json("POST", { target: "output_dir", analysisId: id }));
        expect(response.status).toBe(500);
        expect(((await response.json()) as ApiError).error).toBe("internal_error");
        expect(opened).toEqual([]);
    });

    test("a path or a URL in the body is never read: the opener gets only the data folder", async () => {
        const { routes, opened } = opener();
        for (const extra of [{ path: "/etc" }, { url: "https://example.com" }]) {
            const response = await routes.request("/open", json("POST", { target: "data_dir", ...extra }));
            expect(response.status).toBe(200);
        }
        expect(opened).toEqual([env.dataDir, env.dataDir]);
    });

    test("an opener that fails is 200 `opened: false`", async () => {
        const { routes, opened } = opener({ type: "open_failed", code: "ENOENT", cause: new Error("no opener") });
        const response = await routes.request("/open", json("POST", { target: "data_dir" }));
        expect(response.status).toBe(200);
        expect((await response.json()) as OpenFolderResult).toEqual({ opened: false });
        expect(opened).toEqual([env.dataDir]);
    });

    test("a body that is not JSON is 400 `invalid_json`, and opens nothing", async () => {
        const { routes, opened } = opener();
        const response = await routes.request("/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
        expect(response.status).toBe(400);
        expect(((await response.json()) as ApiError).error).toBe("invalid_json");
        expect(opened).toEqual([]);
    });
});
