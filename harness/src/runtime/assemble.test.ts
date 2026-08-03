import { describe, expect, it } from "bun:test";

import { createThreadAgentResolver } from "./assemble.js";
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

// The registry `assembleCoreRuntime` builds today: only `conversation`.
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
