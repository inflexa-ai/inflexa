import { describe, expect, test } from "bun:test";

import {
    CONTAINER_DATA_PATH,
    CONTAINER_PG_PORT,
    DEFAULT_DATABASE,
    DEFAULT_IMAGE,
    DEFAULT_PASSWORD,
    DEFAULT_PORT,
    DEFAULT_USER,
    type PostgresError,
} from "./postgres_types.ts";
import { resolvePostgresConfig } from "../../lib/config.ts";
import { generateComposeFile, POSTGRES_CONTAINER_NAME, PROXY_CONTAINER_NAME } from "./compose.ts";

describe("postgres constants", () => {
    test("container name includes inflexa-postgres (dev or prod prefix)", () => {
        expect(POSTGRES_CONTAINER_NAME).toContain("postgres");
    });

    test("default image is pgvector/pgvector:pg18", () => {
        expect(DEFAULT_IMAGE).toBe("pgvector/pgvector:pg18");
    });

    test("default port is 8432 (off standard 5432 and harness testcontainer 5433)", () => {
        expect(DEFAULT_PORT).toBe(8432);
        expect(DEFAULT_PORT).not.toBe(5432);
        expect(DEFAULT_PORT).not.toBe(5433);
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
        expect(conn.port).toBe(DEFAULT_PORT);
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
    test("generated compose file contains both services", () => {
        const conn = resolvePostgresConfig();
        const yaml = generateComposeFile(conn);
        expect(yaml).toContain(`${PROXY_CONTAINER_NAME}:`);
        expect(yaml).toContain(`${POSTGRES_CONTAINER_NAME}:`);
    });

    test("generated compose file contains the shared network", () => {
        const conn = resolvePostgresConfig();
        const yaml = generateComposeFile(conn);
        expect(yaml).toContain("networks:");
        expect(yaml).toContain("driver: bridge");
    });

    test("generated compose file uses correct postgres credentials", () => {
        const conn = { host: "localhost", port: 9999, database: "testdb", user: "testuser", password: "testpass" };
        const yaml = generateComposeFile(conn);
        expect(yaml).toContain('POSTGRES_DB: "testdb"');
        expect(yaml).toContain('POSTGRES_USER: "testuser"');
        expect(yaml).toContain('POSTGRES_PASSWORD: "testpass"');
        expect(yaml).toContain('"9999:5432"');
    });

    test("generated compose file uses the fixed pgvector image", () => {
        const conn = resolvePostgresConfig();
        const yaml = generateComposeFile(conn);
        expect(yaml).toContain(`image: ${DEFAULT_IMAGE}`);
    });

    test("both services have restart: unless-stopped", () => {
        const conn = resolvePostgresConfig();
        const yaml = generateComposeFile(conn);
        const matches = yaml.match(/restart: unless-stopped/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBe(2);
    });
});
