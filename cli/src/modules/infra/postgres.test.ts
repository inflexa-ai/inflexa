import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
    CONTAINER_DATA_PATH,
    CONTAINER_PG_PORT,
    DEFAULT_DATABASE,
    DEFAULT_IMAGE,
    DEFAULT_PASSWORD,
    DEFAULT_USER,
    type PostgresError,
} from "./postgres_types.ts";
import { resolvePostgresConfig } from "../../lib/config.ts";
import * as container from "../../lib/container.ts";
import { runtimes, type CaptureResult } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { generateComposeFile, POSTGRES_CONTAINER_NAME, PROXY_CONTAINER_NAME } from "./compose.ts";
import { waitForReady } from "./postgres.ts";

describe("postgres constants", () => {
    test("container name includes inflexa-postgres (dev or prod prefix)", () => {
        expect(POSTGRES_CONTAINER_NAME).toContain("postgres");
    });

    test("default image is pgvector pinned by tag AND digest, never a floating tag", () => {
        expect(DEFAULT_IMAGE).toBe("pgvector/pgvector:0.8.5-pg18@sha256:12a379b47ad65289572ea0756efc11b7c241a6662833e8af7038cd3b73d647e0");
        // Same PG major (18) as the prior floating `pg18` tag, so existing data dirs load unchanged.
        expect(DEFAULT_IMAGE).toContain("pg18");
        // A digest pin makes a republished tag inert; a bare/floating tag is the regression this guards.
        expect(DEFAULT_IMAGE).toContain("@sha256:");
        expect(DEFAULT_IMAGE).not.toContain(":latest");
    });

    test("default credentials are inflexa/inflexa/inflexa", () => {
        expect(DEFAULT_DATABASE).toBe("inflexa");
        expect(DEFAULT_USER).toBe("inflexa");
        expect(DEFAULT_PASSWORD).toBe("inflexa");
    });

    test("container PG port is 5432 (the image's internal port)", () => {
        expect(CONTAINER_PG_PORT).toBe(5432);
    });

    test("container data path is /var/lib/postgresql (PG 18+ parent mount)", () => {
        expect(CONTAINER_DATA_PATH).toBe("/var/lib/postgresql");
    });
});

describe("resolvePostgresConfig", () => {
    test("returns all defaults when no config file exists (test environment)", () => {
        const conn = resolvePostgresConfig();
        expect(conn.host).toBe("localhost");
        // The port default is channel-aware: with nothing persisted it falls to env.postgresPort
        // (8434 in a dev/test process, 8432 in a production build), never a fixed constant.
        expect(conn.port).toBe(env.postgresPort);
        expect(conn.database).toBe(DEFAULT_DATABASE);
        expect(conn.user).toBe(DEFAULT_USER);
        expect(conn.password).toBe(DEFAULT_PASSWORD);
    });

    test("no field is undefined — every field is fully populated", () => {
        const conn = resolvePostgresConfig();
        for (const value of Object.values(conn)) {
            expect(value).toBeDefined();
            expect(value).not.toBeUndefined();
        }
    });
});

// A persisted port equal to a RESERVED channel default (prod 8432 / dev 8434) is the freeze bug older
// builds wrote into the channel-shared config.json — resolve must IGNORE it and fall back to this channel's
// sibling default, so an existing frozen pin self-heals from EITHER channel (the dev developer no longer
// needs to run the prod binary). A genuinely custom port is still honored. Writes land in the sandboxed
// config; each test starts and ends from a clean config so the "no config file exists" test above is unaffected.
describe("resolvePostgresConfig — reserved-port healing", () => {
    function writePersistedPort(port: number): void {
        assertTestSandbox(env.configPath);
        mkdirSync(dirname(env.configPath), { recursive: true });
        writeFileSync(env.configPath, JSON.stringify({ telemetry: false, postgres: { port } }));
    }

    beforeEach(() => {
        assertTestSandbox(env.configPath);
        rmSync(env.configPath, { force: true });
    });
    afterEach(() => {
        assertTestSandbox(env.configPath);
        rmSync(env.configPath, { force: true });
    });

    test("a frozen production default (8432) is ignored and resolves to this channel's default", () => {
        writePersistedPort(8432);
        expect(resolvePostgresConfig().port).toBe(env.postgresPort);
    });

    test("a frozen dev default (8434) is ignored and resolves to this channel's default", () => {
        writePersistedPort(8434);
        expect(resolvePostgresConfig().port).toBe(env.postgresPort);
    });

    test("a genuinely custom persisted port is honored", () => {
        writePersistedPort(6000);
        expect(resolvePostgresConfig().port).toBe(6000);
    });
});

describe("PostgresError variants", () => {
    test("image_pull_failed variant names the image", () => {
        const e: PostgresError = {
            type: "image_pull_failed",
            image: DEFAULT_IMAGE,
            message: `Failed to pull ${DEFAULT_IMAGE}.`,
        };
        expect(e.type).toBe("image_pull_failed");
        expect(e.image).toBe(DEFAULT_IMAGE);
    });

    test("vector_install_failed variant carries an actionable message", () => {
        const e: PostgresError = {
            type: "vector_install_failed",
            message: "The pgvector extension is not available.",
        };
        expect(e.type).toBe("vector_install_failed");
        expect(e.message).toContain("pgvector");
    });

    test("compose_not_available variant carries an actionable message", () => {
        const e: PostgresError = {
            type: "compose_not_available",
            message: "Docker Compose is not available.",
        };
        expect(e.type).toBe("compose_not_available");
    });
});

describe("compose file generation", () => {
    test("cliproxy mode contains both services", () => {
        const conn = resolvePostgresConfig();
        const yaml = generateComposeFile(conn, "cliproxy");
        expect(yaml).toContain(`${PROXY_CONTAINER_NAME}:`);
        expect(yaml).toContain(`${POSTGRES_CONTAINER_NAME}:`);
    });

    test("direct mode defines no proxy service but keeps Postgres", () => {
        const conn = resolvePostgresConfig();
        const yaml = generateComposeFile(conn, "direct");
        expect(yaml).not.toContain(`${PROXY_CONTAINER_NAME}:`);
        expect(yaml).toContain(`${POSTGRES_CONTAINER_NAME}:`);
        // The proxy image and its config/auth mounts vanish with the service.
        expect(yaml).not.toContain("cli-proxy-api");
    });

    test("generated compose file contains the shared network", () => {
        const conn = resolvePostgresConfig();
        const yaml = generateComposeFile(conn, "cliproxy");
        expect(yaml).toContain("networks:");
        expect(yaml).toContain("driver: bridge");
    });

    test("generated compose file uses correct postgres credentials", () => {
        const conn = { host: "localhost", port: 9999, database: "testdb", user: "testuser", password: "testpass" };
        const yaml = generateComposeFile(conn, "cliproxy");
        expect(yaml).toContain('POSTGRES_DB: "testdb"');
        expect(yaml).toContain('POSTGRES_USER: "testuser"');
        expect(yaml).toContain('POSTGRES_PASSWORD: "testpass"');
        expect(yaml).toContain('"127.0.0.1:9999:5432"');
    });

    test("published ports bind to loopback only, never all interfaces (LAN)", () => {
        const conn = { host: "localhost", port: 9999, database: "testdb", user: "testuser", password: "testpass" };
        const yaml = generateComposeFile(conn, "cliproxy");
        // Docker publishes a bare "host:container" mapping on 0.0.0.0 (every
        // interface); the 127.0.0.1 prefix keeps Postgres and the credential-bearing
        // proxy reachable only from this host. A bare numeric mapping is the
        // regression this guards — it would re-expose both services to the LAN.
        expect(yaml).toContain('"127.0.0.1:9999:5432"');
        expect(yaml).not.toMatch(/-\s+"\d+:\d+"/);
    });

    test("generated compose file uses the fixed pgvector image", () => {
        const conn = resolvePostgresConfig();
        expect(generateComposeFile(conn, "cliproxy")).toContain(`image: ${DEFAULT_IMAGE}`);
        expect(generateComposeFile(conn, "direct")).toContain(`image: ${DEFAULT_IMAGE}`);
    });

    test("both service images carry a tag AND a digest — neither floats — in every mode", () => {
        const conn = resolvePostgresConfig();
        const cliproxy = generateComposeFile(conn, "cliproxy");
        // The proxy image is pinned by tag+digest and present only in cliproxy mode.
        expect(cliproxy).toContain("image: eceasy/cli-proxy-api:v7.2.148@sha256:");
        expect(cliproxy).toContain("image: pgvector/pgvector:0.8.5-pg18@sha256:");
        // No floating tag in either mode.
        expect(cliproxy).not.toContain(":latest");
        expect(generateComposeFile(conn, "direct")).not.toContain(":latest");
    });

    test("compose ports and mounts derive from env, not hardcoded literals", () => {
        const conn = resolvePostgresConfig();
        const yaml = generateComposeFile(conn, "cliproxy");
        // Postgres publishes the resolved (channel-aware) host port over the in-container 5432.
        expect(yaml).toContain(`"127.0.0.1:${conn.port}:${CONTAINER_PG_PORT}"`);
        expect(conn.port).toBe(env.postgresPort);
        // The proxy publishes and the mounts bind the env-derived (channel-aware) paths/port.
        expect(yaml).toContain(`"127.0.0.1:${env.cliproxyPort}:${env.cliproxyPort}"`);
        expect(yaml).toContain(`"${env.cliproxyConfigPath}:`);
        expect(yaml).toContain(`"${env.cliproxyAuthDir}:`);
        expect(yaml).toContain(`"${env.postgresDataDir}:${CONTAINER_DATA_PATH}"`);
    });

    test("cliproxy mode gives both services restart: unless-stopped; direct only Postgres", () => {
        const conn = resolvePostgresConfig();
        expect(generateComposeFile(conn, "cliproxy").match(/restart: unless-stopped/g)!.length).toBe(2);
        expect(generateComposeFile(conn, "direct").match(/restart: unless-stopped/g)!.length).toBe(1);
    });
});

// The wait runs on a fake clock and a scripted engine, so neither a real 30s nor a real container is
// involved. `poll` counts the `pg_isready` calls, and every other engine call is answered for the
// current poll — the order the wait itself imposes (exec, then inspect, then logs on a failure).
describe("waitForReady", () => {
    const INITDB_ERROR = 'initdb: error: could not change permissions of directory "/var/lib/postgresql/18/docker": Operation not permitted';
    const spies: Array<{ mockRestore: () => void }> = [];
    afterEach(() => {
        for (const spy of spies.splice(0)) spy.mockRestore();
    });

    type Script = {
        /** Whether `pg_isready` passes on this poll (1-based). */
        ready: (poll: number) => boolean;
        /** The restart count the engine reports on this poll, or `null` for an engine that reports none. */
        restarts: (poll: number) => number | null;
        /** The answer of the `logs` call. */
        logs: CaptureResult;
    };

    /** Install the fake clock and the scripted engine; returns the counters the assertions read. */
    function drive(script: Script): { sleeps: number[]; polls: () => number } {
        let now = 1_000_000;
        let poll = 0;
        const sleeps: number[] = [];
        spies.push(spyOn(Date, "now").mockImplementation(() => now));
        // The sleep advances the clock instead of waiting, so the deadline is reached in no real time.
        spies.push(
            spyOn(Promise, "sleep").mockImplementation(async (ms: number) => {
                sleeps.push(ms);
                now += ms;
            }),
        );
        spies.push(
            spyOn(container, "capture").mockImplementation(async (_rt, args) => {
                if (args[0] === "exec") {
                    poll += 1;
                    return { code: script.ready(poll) ? 0 : 2, stdout: "", stderr: "no response" };
                }
                if (args[0] === "container" && args[1] === "inspect") {
                    const count = script.restarts(poll);
                    return count === null ? { code: 1, stdout: "", stderr: "no such field" } : { code: 0, stdout: `${count}\n`, stderr: "" };
                }
                if (args[0] === "logs") return script.logs;
                return { code: 1, stdout: "", stderr: `unexpected engine call: ${args.join(" ")}` };
            }),
        );
        return { sleeps, polls: () => poll };
    }

    const conn = resolvePostgresConfig();
    const initdbLog: CaptureResult = { code: 0, stdout: "fixing permissions on existing directory\n", stderr: `${INITDB_ERROR}\n` };

    test("a restart count that rises by 2 stops the wait at once, with the container log", async () => {
        const run = drive({ ready: () => false, restarts: (poll) => poll - 1, logs: initdbLog });

        const error = (await waitForReady(runtimes.podman, conn))._unsafeUnwrapErr();

        expect(error.type).toBe("container_crash_loop");
        // Poll 1 reads 0 (the baseline), poll 2 reads 1, poll 3 reads 2 — two sleeps, not sixty.
        expect(run.polls()).toBe(3);
        expect(run.sleeps).toEqual([500, 500]);
        // Both streams reach the message: the entrypoint writes the fatal line to stderr.
        expect(error.message).toContain(INITDB_ERROR);
        expect(error.message).toContain("fixing permissions on existing directory");
        expect(error.message).toContain(`podman logs ${POSTGRES_CONTAINER_NAME}`);
    });

    test("a rise of 1 is not yet a loop: the wait goes on, and a later pass is success", async () => {
        const run = drive({ ready: (poll) => poll === 4, restarts: (poll) => (poll === 1 ? 0 : 1), logs: initdbLog });
        (await waitForReady(runtimes.docker, conn))._unsafeUnwrap();
        expect(run.polls()).toBe(4);
    });

    test("a restart count from before the wait gives no error", async () => {
        // The count is for the life of the container: 5 past restarts, none during this wait.
        const run = drive({ ready: (poll) => poll === 3, restarts: () => 5, logs: initdbLog });
        (await waitForReady(runtimes.docker, conn))._unsafeUnwrap();
        expect(run.polls()).toBe(3);
    });

    test("an engine with no restart count keeps the timeout, which now carries the container log", async () => {
        const run = drive({ ready: () => false, restarts: () => null, logs: initdbLog });

        const error = (await waitForReady(runtimes.docker, conn))._unsafeUnwrapErr();

        expect(error.type).toBe("ready_timeout");
        // The full 30s of 500ms polls ran on the fake clock.
        expect(run.sleeps.length).toBe(60);
        expect(error.message).toContain("within 30s");
        expect(error.message).toContain(INITDB_ERROR);
        expect(error.message).toContain(`docker logs ${POSTGRES_CONTAINER_NAME}`);
    });

    test("a log that the engine cannot give does not hide either error", async () => {
        const noLogs: CaptureResult = { code: 1, stdout: "", stderr: "no such container" };

        drive({ ready: () => false, restarts: (poll) => poll - 1, logs: noLogs });
        const loop = (await waitForReady(runtimes.docker, conn))._unsafeUnwrapErr();
        expect(loop.type).toBe("container_crash_loop");
        expect(loop.message).toContain("keeps restarting");
        expect(loop.message).not.toContain("Last lines of the container log");
        expect(loop.message).toContain(`docker logs ${POSTGRES_CONTAINER_NAME}`);

        for (const spy of spies.splice(0)) spy.mockRestore();
        drive({ ready: () => false, restarts: () => null, logs: noLogs });
        const timeout = (await waitForReady(runtimes.docker, conn))._unsafeUnwrapErr();
        expect(timeout.type).toBe("ready_timeout");
        expect(timeout.message).not.toContain("Last lines of the container log");
        expect(timeout.message).toContain(`docker logs ${POSTGRES_CONTAINER_NAME}`);
    });
});
