import { describe, expect, it } from "bun:test";

import { composeBriefing } from "./compose.js";
import { priorPlanBriefing } from "./prior-plan.js";
import { priorPlanFixture } from "./prior-plan.fixture.js";

describe("priorPlanBriefing", () => {
    it("renders its fixture in isolation, matching the snapshot", () => {
        const rendered = priorPlanBriefing.render(priorPlanFixture);

        // No I/O — a pure render from the colocated fixture.
        expect(rendered.content).toMatchSnapshot();
        expect(rendered.caption).toMatchSnapshot();
    });

    it("captions with the plan id and step count", () => {
        const { caption } = priorPlanBriefing.render(priorPlanFixture);
        expect(caption).toBe("iterating pln-1a2b3c4d · 2 steps");
    });

    it("renders the narrative and one line per step with id/agent/name/question/deps", () => {
        const { content } = priorPlanBriefing.render(priorPlanFixture);
        expect(content).toContain("**Analytical narrative:**");
        expect(content).toContain("**T1S1** (bulk-transcriptomics-agent): Differential expression —");
        expect(content).toContain("**T1S2** (enrichment-agent): Pathway enrichment —");
        expect(content).toContain("[deps: T1S1]");
    });

    it("carries the preserve-step-IDs iteration guidance", () => {
        const { content } = priorPlanBriefing.render(priorPlanFixture);
        expect(content).toContain("Reuse step IDs");
        expect(content).toContain("Preserve steps and IDs");
    });

    it("renders deterministically across calls", () => {
        const a = priorPlanBriefing.render(priorPlanFixture);
        const b = priorPlanBriefing.render(priorPlanFixture);
        expect(a).toEqual(b);
    });

    it("is a standing briefing", () => {
        expect(priorPlanBriefing.mode).toBe("standing");
    });

    it('composes into a single user <briefing name="prior-plan"> message', () => {
        const composed = composeBriefing(priorPlanBriefing, priorPlanFixture);
        expect(composed.name).toBe("prior-plan");
        expect(composed.message.role).toBe("user");
        const text = composed.message.content as string;
        expect(text.startsWith('<briefing name="prior-plan">')).toBe(true);
    });
});
