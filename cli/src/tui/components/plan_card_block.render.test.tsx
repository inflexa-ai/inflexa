import { describe, expect, test } from "bun:test";
import { renderFrame } from "../../test_support/tui.ts";

import { PlanCardBlock } from "./plan_card_block.tsx";
import type { PlanCardStepView } from "../../types/session.ts";

function step(id: string, depends_on: string[] = [], name = id): PlanCardStepView {
    return {
        id,
        name,
        agent: "scientific-executor",
        question: "question",
        acceptance_criteria: [],
        constraints: [],
        caveats: [],
        depends_on,
        resources: null,
        track: "track",
        step_type: "analysis",
    };
}

describe("PlanCardBlock", () => {
    for (const width of [80, 100, 120]) {
        test(`renders a branching graph without overlap at width ${width}`, async () => {
            const frame = await renderFrame(
                () => <PlanCardBlock planId="plan-1" title="Branching plan" steps={[step("A"), step("B", ["A"]), step("C", ["A"])]} />,
                { width, height: 14 },
            );
            expect(frame).toContain("Branching plan");
            expect(frame).toContain("┌");
            expect(frame).toContain("┴");
        });
    }

    test("an empty plan degrades to the flat empty state", async () => {
        const frame = await renderFrame(() => <PlanCardBlock planId="plan-empty" title="Empty plan" steps={[]} />, { width: 80, height: 6 });
        expect(frame).toContain("Empty plan");
        expect(frame).not.toContain("┌");
    });

    test("a renderer error degrades to the flat step list", async () => {
        const broken = [step("A", [], "Fallback step")];
        // Test-only fault injection: planToDag calls `map`; Solid's For fallback reads array indices.
        broken.map = (): never => {
            throw new Error("render failed");
        };
        const frame = await renderFrame(() => <PlanCardBlock planId="plan-broken" title="Broken plan" steps={broken} />, { width: 80, height: 6 });
        expect(frame).toContain("Fallback step");
        expect(frame).toContain("[scientific-executor]");
    });
});
