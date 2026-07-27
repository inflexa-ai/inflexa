import { afterEach, describe, expect, test } from "bun:test";

import { GLYPHS } from "../lib/design_system.ts";
import { __setAgentModelsForTest, __setBootStateForTest } from "./hooks/boot.ts";
import { commands, modelStatusLines, type CommandId } from "./commands.tsx";
import type { Workspace } from "./contexts/workspace.ts";
import type { Analysis } from "../types/analysis.ts";

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

// The three session commands read the module-level boot store and the workspace scope. Thread metadata
// lives only in Postgres, so before `ready` there is nothing to list, retitle, or remove; rename and
// delete additionally need a bound thread to act on. These drive the registry's own `enabled`
// predicates rather than a hand-rolled copy, so a re-wired gate fails here.
describe("session command gating", () => {
    // Only `id`/`name` are load-bearing (the predicates read the scope, not the row), so a partial
    // stand-in cast keeps the fixture flat — the same shape `workspace.test.ts` uses.
    const ANALYSIS = { id: "a1", name: "Alpha", projectId: null } as unknown as Analysis;

    /** A scope stand-in carrying only the two fields the session predicates read. */
    function scope(analysis: Analysis | null, sessionId: string | null): Workspace {
        return { analysis, sessionId } as unknown as Workspace;
    }

    /**
     * A command's availability under `ws`. `undefined` when the id is missing OR the command declares no
     * gate at all — both are registry regressions this suite must not read as "enabled", so the callers
     * assert against `true`/`false` rather than truthiness.
     */
    function enabledOf(id: CommandId, ws: Workspace): boolean | undefined {
        return commands.find((c) => c.id === id)?.enabled?.(ws);
    }

    const BOUND = scope(ANALYSIS, "thread-bound-1");

    test("all three are unavailable before boot reaches ready, even with a bound thread", () => {
        for (const phase of [{ phase: "idle" }, { phase: "booting" }, { phase: "failed", message: "postgres unreachable" }] as const) {
            __setBootStateForTest(phase);
            expect(enabledOf("session.switch", BOUND)).toBe(false);
            expect(enabledOf("session.rename", BOUND)).toBe(false);
            expect(enabledOf("session.delete", BOUND)).toBe(false);
        }
    });

    test("ready with no thread bound yet: switching is offered, rename and delete are not", () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        const unbound = scope(ANALYSIS, null);
        // Switching is how the user reaches an existing thread while the scope is still unbound.
        expect(enabledOf("session.switch", unbound)).toBe(true);
        expect(enabledOf("session.rename", unbound)).toBe(false);
        expect(enabledOf("session.delete", unbound)).toBe(false);
    });

    test("ready with a bound thread offers all three", () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        expect(enabledOf("session.switch", BOUND)).toBe(true);
        expect(enabledOf("session.rename", BOUND)).toBe(true);
        expect(enabledOf("session.delete", BOUND)).toBe(true);
    });

    test("no analysis in scope: the analysis-scoped session commands stay unavailable", () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        const noAnalysis = scope(null, "thread-bound-1");
        expect(enabledOf("session.switch", noAnalysis)).toBe(false);
        expect(enabledOf("session.delete", noAnalysis)).toBe(false);
    });
});
