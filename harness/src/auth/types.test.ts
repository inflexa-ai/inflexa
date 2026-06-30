import { describe, expect, it } from "bun:test";

import { makeSession } from "../providers/__fixtures__/session.js";
import { forSubAgent, scopeResource, scopeWorkloadId, type Scope } from "./types.js";

describe("scope coordinate derivation", () => {
    it("analysis scope derives the analysis resource + tag", () => {
        const scope: Scope = { kind: "analysis", analysisId: "analysis-xyz" };
        expect(scopeResource(scope)).toEqual({
            resourceType: "analysis",
            resourceId: "analysis-xyz",
        });
        expect(scopeWorkloadId(scope)).toBe("analysis-xyz");
    });

    it("target-assessment scope resolves via the billing-context discriminator", () => {
        const scope: Scope = {
            kind: "target-assessment",
            targetAssessmentId: "ta-1",
            billingContextId: "bc-9",
        };
        expect(scopeResource(scope)).toEqual({
            resourceType: "billing_context",
            resourceId: "bc-9",
        });
        expect(scopeWorkloadId(scope)).toBe("ta-1");
    });

    it("threadId lives only on the analysis variant", () => {
        const scope: Scope = {
            kind: "analysis",
            analysisId: "analysis-xyz",
            threadId: "thread-1",
        };
        expect(scope.kind === "analysis" ? scope.threadId : undefined).toBe("thread-1");
    });
});

describe("forSubAgent", () => {
    it("appends to callPath and sets agentId without mutating the parent", () => {
        const parent = makeSession({
            agentId: "conversation-agent",
            callPath: ["conversation-agent"],
        });

        const child = forSubAgent(parent, "literature-reviewer");

        expect(child.provenance.agentId).toBe("literature-reviewer");
        expect(child.provenance.callPath).toEqual(["conversation-agent", "literature-reviewer"]);

        // Parent is untouched.
        expect(parent.provenance.agentId).toBe("conversation-agent");
        expect(parent.provenance.callPath).toEqual(["conversation-agent"]);
        expect(child).not.toBe(parent);
        expect(child.provenance).not.toBe(parent.provenance);
    });

    it("carries identity, scope, and auth through unchanged", () => {
        const parent = makeSession({
            user: "user-xyz",
            scope: {
                kind: "target-assessment",
                targetAssessmentId: "ta-9",
                billingContextId: "bc-9",
            },
        });

        const child = forSubAgent(parent, "sub-agent");

        expect(child.identity).toBe(parent.identity);
        expect(child.scope).toBe(parent.scope);
        expect(child.auth).toBe(parent.auth);
    });

    it("composes — a grandchild appends a third hop", () => {
        const root = makeSession({ callPath: ["conversation-agent"] });
        const grandchild = forSubAgent(forSubAgent(root, "literature-reviewer"), "deep-search");

        expect(grandchild.provenance.callPath).toEqual(["conversation-agent", "literature-reviewer", "deep-search"]);
        expect(grandchild.provenance.agentId).toBe("deep-search");
        expect(root.provenance.callPath).toEqual(["conversation-agent"]);
    });
});
