/**
 * Unit tests for the static realization of the eyes seam.
 *
 * The realization provisions nothing, thus the tests read the endpoint that it gives and the refusal that it
 * raises over a config with no endpoint.
 */

import { describe, expect, it } from "bun:test";

import { createStaticEyes } from "./eyes.js";

const SCOPE = { analysisId: "analysis-1", workspaceRoot: "/workspaces/analysis-1" };

describe("createStaticEyes", () => {
    it("gives the configured endpoint, and its release resolves", async () => {
        const acquire = createStaticEyes({ browserUrl: "http://sidecar.test:9222" });

        const lease = await acquire(SCOPE);

        expect(lease.browserUrl).toBe("http://sidecar.test:9222");
        await expect(lease.release()).resolves.toBeUndefined();
    });

    it("gives the same endpoint for each scope", async () => {
        const acquire = createStaticEyes({ browserUrl: "http://sidecar.test:9222" });

        const first = await acquire(SCOPE);
        const second = await acquire({ analysisId: "analysis-2", workspaceRoot: "/workspaces/analysis-2" });

        expect(second.browserUrl).toBe(first.browserUrl);
    });

    it("refuses a config that names no endpoint", () => {
        expect(() => createStaticEyes({})).toThrow("browser endpoint");
        expect(() => createStaticEyes({ browserUrl: "" })).toThrow("browser endpoint");
        expect(() => createStaticEyes({ browserUrl: "   " })).toThrow("browser endpoint");
    });
});
