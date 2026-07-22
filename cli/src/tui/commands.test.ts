import { afterEach, describe, expect, test } from "bun:test";

import { GLYPHS } from "../lib/design_system.ts";
import { __setAgentModelsForTest, __setBootStateForTest } from "./hooks/boot.ts";
import { modelStatusLines } from "./commands.tsx";

// modelStatusLines reads the module-level boot + agentModels stores, so each test seeds them via the
// test hooks and the reset below keeps one test's seed from bleeding into the next (the same pairing
// sidebar.render.test.tsx uses for the rail's MODELS section).
afterEach(() => {
    __setAgentModelsForTest({ current: { conversation: "", sandbox: "" }, pending: new Map() });
    __setBootStateForTest({ phase: "idle" });
});

describe("modelStatusLines", () => {
    test("before boot reaches ready it mirrors the rail's placeholder", () => {
        expect(modelStatusLines()).toEqual(["models: runtime not ready"]);
    });

    test("a failed boot surfaces its actionable message", () => {
        __setBootStateForTest({ phase: "failed", message: "proxy unreachable — run inflexa up" });
        const [line] = modelStatusLines();
        expect(line).toContain("boot failed");
        expect(line).toContain("proxy unreachable — run inflexa up");
    });

    test("ready: spells out the cliproxy connection and each agent's live model", () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        __setAgentModelsForTest({ current: { conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5" }, pending: new Map() });
        const lines = modelStatusLines();
        expect(lines[0]).toContain("anthropic");
        expect(lines[0]).toContain("cliproxy (managed local proxy)");
        expect(lines[1]).toBe("chat model: claude-opus-4-8");
        expect(lines[2]).toBe("sandbox model: claude-sonnet-4-5");
    });

    test("ready: a direct connection glosses the user-configured endpoint", () => {
        __setBootStateForTest({ phase: "ready", model: "deepseek-chat", connection: { provider: "deepseek", mode: "direct" } });
        __setAgentModelsForTest({ current: { conversation: "deepseek-chat", sandbox: "deepseek-reasoner" }, pending: new Map() });
        expect(modelStatusLines()[0]).toContain("direct (user-configured endpoint)");
    });

    test("a scheduled switch renders as current → pending on the agent's line", () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        __setAgentModelsForTest({
            current: { conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5" },
            pending: new Map([["sandbox", "claude-haiku-4-5"]]),
        });
        expect(modelStatusLines()[2]).toContain(`claude-sonnet-4-5 ${GLYPHS.arrowRight} claude-haiku-4-5 (pending)`);
    });

    test("an agent whose model the switch has not installed yet renders the em-dash placeholder", () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        expect(modelStatusLines()[1]).toBe(`chat model: ${GLYPHS.emDash}`);
    });
});
