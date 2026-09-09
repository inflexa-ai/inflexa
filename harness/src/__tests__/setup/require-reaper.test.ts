/**
 * Covers the two decisions the guard reaches from the environment alone,
 * before it touches a container runtime. The runtime-probing branches are
 * deliberately not exercised: reaching them means starting the real ryuk
 * sidecar, which is a side effect a unit test must not have.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { assertContainerWillBeReaped, refusalMessage } from "./require-reaper.js";

const TOUCHED = ["CORTEX_TEST_ALLOW_LEAKED_PG", "TESTCONTAINERS_RYUK_DISABLED"] as const;
const saved = new Map(TOUCHED.map((key) => [key, process.env[key]]));

afterEach(() => {
    for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe("assertContainerWillBeReaped", () => {
    it("lets the container start when the leak is explicitly accepted", async () => {
        process.env.CORTEX_TEST_ALLOW_LEAKED_PG = "1";
        // Set too, to prove the opt-in is checked before anything else: this
        // alone would otherwise refuse.
        process.env.TESTCONTAINERS_RYUK_DISABLED = "true";

        await assertContainerWillBeReaped();
    });

    it("refuses when ryuk is disabled, and never reaches the runtime", async () => {
        delete process.env.CORTEX_TEST_ALLOW_LEAKED_PG;
        process.env.TESTCONTAINERS_RYUK_DISABLED = "true";

        await expect(assertContainerWillBeReaped()).rejects.toThrow(/TESTCONTAINERS_RYUK_DISABLED=true/);
    });
});

describe("refusalMessage", () => {
    it("names the reason and both safe routes", () => {
        const message = refusalMessage("the ryuk reaper is not running");

        expect(message).toContain("the ryuk reaper is not running");
        expect(message).toContain("bun run test:full");
        expect(message).toContain("CORTEX_TEST_PG_URL=");
        expect(message).toContain("CORTEX_TEST_ALLOW_LEAKED_PG=1");
    });
});
