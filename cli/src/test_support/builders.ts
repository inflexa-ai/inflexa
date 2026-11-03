import type { AgentSession, RunSession } from "@inflexa-ai/harness";

import type { Workspace } from "../tui/contexts/workspace.ts";
import { asStr256 } from "../lib/types.ts";
import type { Analysis } from "../types/analysis.ts";

/** A complete {@link Analysis} with valid defaults. `overrides` replaces the fields that a test changes. */
export function buildAnalysis(overrides: Partial<Analysis> = {}): Analysis {
    return {
        id: "a1",
        createdAt: 0,
        updatedAt: 0,
        name: asStr256("Alpha"),
        slug: "alpha",
        anchorId: "anchor-1",
        projectId: null,
        ...overrides,
    };
}

/**
 * A complete {@link Workspace} with no open analysis, no thread, and capabilities that do nothing.
 * `overrides` replaces the fields that a test changes, for example `analysis` or a recording `quit`.
 */
export function buildWorkspace(overrides: Partial<Workspace> = {}): Workspace {
    return {
        analysis: null,
        sessionId: null,
        workingDir: "/work",
        project: null,
        anchor: null,
        inputCount: null,
        openDialog: () => undefined,
        closeDialog: () => undefined,
        openSession: () => undefined,
        refreshScope: () => undefined,
        quit: () => Promise.resolve(),
        ...overrides,
    };
}

/**
 * A complete {@link AgentSession} for the analysis `an-test`, under the local identity. The auth capability is
 * opaque and has no readable member, thus an empty object is a valid value. `overrides` replaces the fields that
 * a test changes, for example `scope`.
 */
export function buildAgentSession(overrides: Partial<AgentSession> = {}): AgentSession {
    return {
        identity: { user: "local" },
        scope: { kind: "analysis", analysisId: "an-test" },
        provenance: { agentId: "test", callPath: ["test"] },
        auth: {},
        ...overrides,
    };
}

/**
 * A complete {@link RunSession} for the run `run-1` of the analysis `an-test`, under the local identity. The auth
 * capability is opaque, thus an empty object is a valid value. `overrides` replaces the fields that a test changes.
 */
export function buildRunSession(overrides: Partial<RunSession> = {}): RunSession {
    return {
        identity: { user: "local" },
        scope: { kind: "analysis", analysisId: "an-test" },
        provenance: { agentId: "test", callPath: ["test"] },
        runFrame: { runId: "run-1" },
        auth: {},
        ...overrides,
    };
}
