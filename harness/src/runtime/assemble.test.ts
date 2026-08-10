import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import type { ThreadAgentResolver, UnregisteredThreadType } from "@inflexa-ai/harness";

import { createReportSessionRuntime } from "../app/report-session-runtime.js";
import { withSchema } from "../__tests__/setup/postgres.js";
import { createThreadStore } from "../memory/thread-store.js";
import { upsertAnalysis } from "../state/analyses.js";
import { createThreadAgentResolver, type CoreRuntime, type CoreRuntimeDeps } from "./assemble.js";
import { createFixtureResolver } from "../report-model/fixture-resolver.js";
import type { AgentDefinition } from "../loop/types.js";
import type { ThreadType } from "../memory/thread-store.js";

// A bare `AgentDefinition` stands in for the assembled conversation agent: the
// resolver only ever hands back the object the registry holds, so its internals
// never matter to resolution.
const conversationAgent: AgentDefinition = {
    id: "conversation",
    systemPrompt: "",
    model: "test/model",
    tools: [],
    maxIterations: 1,
};

// A bare `AgentDefinition` stands in for the assembled report agent, the same way
// `conversationAgent` stands in for the conversation agent.
const reportAgent: AgentDefinition = {
    id: "report-session",
    systemPrompt: "",
    model: "test/model",
    tools: [],
    maxIterations: 1,
};

// A registry that holds `conversation` and omits `report`. It exercises the
// refusal path: a resolver built over a registry with no entry for a type refuses.
function registry(): Partial<Record<ThreadType, AgentDefinition>> {
    return { conversation: conversationAgent };
}

describe("createThreadAgentResolver", () => {
    it("resolves the conversation type to the assembled conversation agent", () => {
        const result = createThreadAgentResolver(registry()).forThread("conversation");
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap()).toBe(conversationAgent);
    });

    it("returns one identity across repeated resolution", () => {
        const resolver = createThreadAgentResolver(registry());
        const first = resolver.forThread("conversation");
        const second = resolver.forThread("conversation");
        // Singleton semantics: both calls surface the same object, so a handle
        // captured at construction stays the one every turn resolves.
        expect(first._unsafeUnwrap()).toBe(second._unsafeUnwrap());
    });

    it("resolves the report type to the same assembled singleton across two calls", () => {
        const resolver = createThreadAgentResolver({ conversation: conversationAgent, report: reportAgent });
        const first = resolver.forThread("report");
        const second = resolver.forThread("report");
        expect(first.isOk()).toBe(true);
        expect(first._unsafeUnwrap()).toBe(reportAgent);
        // Singleton semantics: both calls surface the same report agent, so a
        // handle captured at construction stays the one every report turn resolves.
        expect(first._unsafeUnwrap()).toBe(second._unsafeUnwrap());
    });

    it("refuses an unregistered type with a typed error carrying the type", () => {
        // Reduce the Result to whichever branch fired: a registered type would
        // yield its agent, `report` yields its refusal.
        const reduced = createThreadAgentResolver(registry())
            .forThread("report")
            .match(
                (agent) => agent,
                (refusal) => refusal,
            );
        expect(reduced).toEqual({ type: "unregistered_thread_type", threadType: "report" });
    });
});

describe("the report session handle", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("assemble_report_session");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    it("anchors a seeded report thread through the exposed handle", async () => {
        const analysisId = "analysis-assemble";
        const threadId = "thread-assemble";
        (await upsertAnalysis(pool, analysisId, null, null))._unsafeUnwrap();
        (await createThreadStore(pool).createThread({ threadId, analysisId, type: "report" }))._unsafeUnwrap();

        // The exposed handle is the runtime's turn-start anchor. The assignment proves
        // that the `CoreRuntime` field type accepts it; a drift fails tsc.
        const handle: CoreRuntime["reportSession"] = createReportSessionRuntime({ pool });

        const ready = await handle.ensureSessionState(threadId);
        expect(ready.outcome).toBe("ready");
    });
});

describe("the report reference resolver dep", () => {
    it("carries an optional reference resolver, thus an embedder can wire the report preview", () => {
        // The assignment proves that the deps surface accepts the resolver. `assembleCoreRuntime`
        // forwards it to the report agent's preview tool, thus a drift or a dropped field fails this at
        // the type level and takes the one wiring point with it.
        const withResolver: Pick<CoreRuntimeDeps, "reportReferenceResolver"> = { reportReferenceResolver: createFixtureResolver() };
        expect(withResolver.reportReferenceResolver).toBeDefined();
        // The dep is optional, thus the OSS default omits it and the preview tool degrades as data.
        const without: Pick<CoreRuntimeDeps, "reportReferenceResolver"> = {};
        expect(without.reportReferenceResolver).toBeUndefined();
    });
});

describe("the barrel resolution surface", () => {
    it("exports the resolver type, thus an embedder needs no deep path", () => {
        // The assignment proves that the barrel type accepts the built resolver. A
        // drift or a dropped export fails it at the type level.
        const resolver: ThreadAgentResolver = createThreadAgentResolver(registry());
        const outcome = resolver.forThread("report");
        expect(outcome.isErr()).toBe(true);
        // The barrel error type is the refusal type. Thus the error branch assigns to it.
        const refusal: UnregisteredThreadType | undefined = outcome.isErr() ? outcome.error : undefined;
        expect(refusal).toEqual({ type: "unregistered_thread_type", threadType: "report" });
    });
});
