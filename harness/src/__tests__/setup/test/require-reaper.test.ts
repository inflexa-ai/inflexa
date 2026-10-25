/**
 * Covers the decisions the guard reaches from the environment alone, before it
 * touches a container runtime. The runtime-probing branches are deliberately
 * not exercised: reaching them means starting the real ryuk sidecar, which is
 * a side effect a unit test must not have.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { assertContainerWillBeReaped, defaultRyukPrivileged, refusalMessage } from "../require-reaper.js";

const TOUCHED = ["CORTEX_TEST_ALLOW_LEAKED_PG", "TESTCONTAINERS_RYUK_DISABLED"] as const;
const saved = new Map(TOUCHED.map((key) => [key, process.env[key]]));

afterEach(() => {
    for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe("assertContainerWillBeReaped", () => {
    // The removed variable must not get past the guard.
    it("refuses when ryuk is disabled, and never reaches the runtime", async () => {
        process.env.CORTEX_TEST_ALLOW_LEAKED_PG = "1";
        process.env.TESTCONTAINERS_RYUK_DISABLED = "true";

        await expect(assertContainerWillBeReaped()).rejects.toThrow("TESTCONTAINERS_RYUK_DISABLED=true disables");
    });
});

describe("defaultRyukPrivileged", () => {
    it("sets the variable to true when it is absent", () => {
        const env: NodeJS.ProcessEnv = {};

        defaultRyukPrivileged(env);

        expect(env.TESTCONTAINERS_RYUK_PRIVILEGED).toBe("true");
    });

    it("keeps a value that the developer set", () => {
        const env: NodeJS.ProcessEnv = { TESTCONTAINERS_RYUK_PRIVILEGED: "false" };

        defaultRyukPrivileged(env);

        expect(env.TESTCONTAINERS_RYUK_PRIVILEGED).toBe("false");
    });

    it("keeps the empty value", () => {
        const env: NodeJS.ProcessEnv = { TESTCONTAINERS_RYUK_PRIVILEGED: "" };

        defaultRyukPrivileged(env);

        expect(env.TESTCONTAINERS_RYUK_PRIVILEGED).toBe("");
    });
});

describe("refusalMessage", () => {
    it("names the reason and both safe routes", () => {
        const message = refusalMessage("the ryuk reaper is not running");

        expect(message).toContain("the ryuk reaper is not running");
        expect(message).toContain("bun run test:full");
        expect(message).toContain("CORTEX_TEST_PG_URL=");
    });

    it("names the podman variables and offers no route without a reaper", () => {
        const message = refusalMessage("the ryuk reaper is not running");

        expect(message).toContain("DOCKER_HOST");
        expect(message).toContain("TESTCONTAINERS_RYUK_PRIVILEGED=true");
        expect(message).toContain("TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE");
        expect(message).not.toContain("CORTEX_TEST_ALLOW_LEAKED_PG");
    });
});
