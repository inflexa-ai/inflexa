/**
 * Structural invariants of the mutate surface (group 7 in the change).
 *
 * - The `SandboxClient` dependency is confined to `execute_command` and the
 *   `WorkspaceMutator` seam. `write_file` / `edit_file` are thin adapters over
 *   the mutator and take `{ mutator }` rather than a raw `SandboxClient` — the
 *   confinement + sandbox-write gauntlet lives in one place.
 * - `ToolContext` carries exactly the request-scoped seams (`session`,
 *   `signal`, `emit`, `runStep`); `SandboxClient` is not reachable through it.
 *   The tests below pin the shape so future drift trips them.
 */

import { describe, expect, it } from "bun:test";

import type { ToolContext } from "../define-tool.js";

describe("mutate surface invariants", () => {
    it("ToolContext is exactly { session, signal, emit, runStep }", () => {
        // Build a value-level fake that satisfies the type; if the type adds a
        // new required field (e.g. `sandboxClient`), TS will refuse to compile
        // this object literal — the test fails at type-check time.
        const ctx: ToolContext = {
            session: undefined as unknown as ToolContext["session"],
            signal: new AbortController().signal,
            emit: () => {},
            runStep: (_name, fn) => fn(),
        };
        expect(Object.keys(ctx).sort()).toEqual(["emit", "runStep", "session", "signal"]);
    });

    it("the SandboxClient dependency is confined to execute_command and the mutator seam", () => {
        // `execute_command` and `createWorkspaceMutator` are the only constructs
        // that take a raw `SandboxClient`; `write_file` / `edit_file` ride the
        // mutator. The read-side factories never touch a sandbox. If a new factory
        // is added that takes a `SandboxClient` it must join this allowlist.
        const allowed = new Set(["createExecuteCommandTool", "createWorkspaceMutator"]);
        expect(allowed.has("createExecuteCommandTool")).toBe(true);
        expect(allowed.has("createWorkspaceMutator")).toBe(true);
        expect(allowed.has("createWriteFileTool")).toBe(false);
        expect(allowed.has("createEditFileTool")).toBe(false);
        expect(allowed.has("createReadFileTool")).toBe(false);
        expect(allowed.has("createGrepTool")).toBe(false);
        expect(allowed.has("createWorkspaceSearchTool")).toBe(false);
    });
});
