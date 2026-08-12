import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { describeBootError, ensureLibStoreUsable, friendlyStepLabel } from "./profile.ts";

// Names as recorded in dbos.operation_outputs by the profile workflow — the
// progress channel parses them, so pin the observed formats.
describe("friendlyStepLabel", () => {
    test("llm steps become 1-based model rounds", () => {
        expect(friendlyStepLabel("llm-0")).toBe("model round 1");
        expect(friendlyStepLabel("llm-9")).toBe("model round 10");
    });

    test("tool steps keep the tool name and drop the call id", () => {
        expect(friendlyStepLabel("tool-list_files-toolu_01GUZLfmSCFH2Jayq9Rhg5ua")).toBe("tool list_files");
        expect(friendlyStepLabel("tool-execute_command-toolu_01D7mGXcJEDoyY9VyMPmzmih")).toBe("tool execute_command");
    });

    test("exec dispatch and recv-loop steps read as sandbox activity", () => {
        expect(friendlyStepLabel("sandbox.submit-exec.dataprofile:an-1:n-1:profile:fn-3")).toBe("dispatching sandbox command");
        expect(friendlyStepLabel("DBOS.recv")).toBe("sandbox executing");
        expect(friendlyStepLabel("DBOS.sleep")).toBe("sandbox executing");
        expect(friendlyStepLabel("DBOS.now")).toBe("sandbox executing");
    });

    test("unknown step names pass through verbatim", () => {
        expect(friendlyStepLabel("DBOS.getResult")).toBe("DBOS.getResult");
    });
});

// The sandbox_engine_unresolved arm carries a message already built against the
// pinned runtime AND host platform at resolution time, so it must be surfaced
// verbatim rather than re-wrapped.
describe("describeBootError", () => {
    test("sandbox_engine_unresolved surfaces the resolution message verbatim", () => {
        const message =
            "Could not resolve the Podman sandbox-engine socket — the Podman machine is not running.\n  Start it with `podman machine start`, then re-run.";
        expect(describeBootError({ type: "sandbox_engine_unresolved", message })).toBe(message);
    });

    // A `cooling_down` cause must read as the self-recovering all-credential block it is, NOT as the
    // generic "proxy is unreachable" the other `model_unresolved` causes render — otherwise the user
    // chases a container that is fine.
    test("model_unresolved cooling_down explains the proxy recovers on its own", () => {
        expect(describeBootError({ type: "model_unresolved", cause: { type: "cooling_down" } })).toContain("recovers on its own");
    });
});

// The ONE store refusal that survives the move of the check out of the harness boot. The boot completes
// with no store now, so chat, the workspace read surface, and the planner answer while the catalog
// arrives — but `inflexa profile` and `inflexa run` each make a sandbox at once and pass through no gate
// of the app, so each keeps this pre-flight. `run.ts` calls the same function, thus one test covers both.
describe("ensureLibStoreUsable — the refusal the two direct sandbox commands keep", () => {
    /** The marker the `process.exit` stand-in throws, so an exit is observable and the suite survives it. */
    const EXIT = "ensureLibStoreUsable called process.exit";

    const spies: { mockRestore: () => void }[] = [];

    beforeEach(() => {
        assertTestSandbox(env.libStoreDir);
        rmSync(env.libStoreDir, { recursive: true, force: true });
    });

    afterEach(() => {
        for (const spy of spies.splice(0)) spy.mockRestore();
        assertTestSandbox(env.libStoreDir);
        rmSync(env.libStoreDir, { recursive: true, force: true });
    });

    /**
     * Run the pre-flight and report the refusal. `fail` prints to stderr and exits, thus a bare call would
     * take the whole test process down. The stand-ins turn the exit into a throw and capture the message,
     * which is the user-facing half of the refusal.
     */
    function refusal(): { exited: boolean; message: string } {
        let message = "";
        spies.push(
            spyOn(console, "error").mockImplementation((first: unknown) => {
                message = String(first);
            }),
            spyOn(process, "exit").mockImplementation((): never => {
                throw new Error(EXIT);
            }),
        );
        try {
            ensureLibStoreUsable();
            return { exited: false, message };
        } catch (cause) {
            if (cause instanceof Error && cause.message === EXIT) return { exited: true, message };
            throw cause;
        }
    }

    test("a store whose pool carries no package refuses, and the message names the remedy", () => {
        // No store root at all, thus `storePackagesFile` resolves to null — the same answer a store with no
        // dependency graph, and a graph that names no package, each give.
        const result = refusal();
        expect(result.exited).toBe(true);
        expect(result.message).toContain(env.libStoreDir);
        expect(result.message).toContain("inflexa store download");
    });

    test("a pool the CLI can describe passes, and the command continues", () => {
        // The graph is the source of the pool inventory, thus a graph with one node is a store from which
        // composition can make a farm.
        mkdirSync(env.libStoreDir, { recursive: true });
        writeFileSync(
            join(env.libStoreDir, "deps.json"),
            JSON.stringify({ version: 1, nodes: { "numpy-1.26.4-0000000000000000": { track: "python", imports: ["numpy"], entry_points: [], edges: [] } } }),
        );
        const result = refusal();
        expect(result.exited).toBe(false);
        expect(result.message).toBe("");
    });
});
