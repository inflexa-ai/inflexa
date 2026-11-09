import { describe, expect, test } from "bun:test";
import { renderFrame } from "../../../test_support/tui.ts";
import { WithTerminalSize } from "../../../test_support/terminal_size.tsx";

import { PlanCardBlock, planGroundingLine } from "../plan_card_block.tsx";
import type { PlanCardGroundingView, PlanCardStepView } from "../../../types/session.ts";

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
        track: "track",
        step_type: "analysis",
    };
}

describe("PlanCardBlock", () => {
    for (const width of [80, 100, 120]) {
        test(`renders a branching graph without overlap at width ${width}`, async () => {
            const frame = await renderFrame(
                () => (
                    <WithTerminalSize>
                        <PlanCardBlock planId="plan-1" title="Branching plan" steps={[step("A"), step("B", ["A"]), step("C", ["A"])]} />
                    </WithTerminalSize>
                ),
                { width, height: 14 },
            );
            expect(frame).toContain("Branching plan");
            expect(frame).toContain("┌");
            expect(frame).toContain("┴");
        });
    }

    test("an empty plan degrades to the flat empty state", async () => {
        const frame = await renderFrame(
            () => (
                <WithTerminalSize>
                    <PlanCardBlock planId="plan-empty" title="Empty plan" steps={[]} />
                </WithTerminalSize>
            ),
            { width: 80, height: 6 },
        );
        expect(frame).toContain("Empty plan");
        expect(frame).not.toContain("┌");
    });

    test("a renderer error degrades to the flat step list", async () => {
        const broken = [step("A", [], "Fallback step")];
        // Test-only fault injection: planToDag calls `map`; Solid's For fallback reads array indices.
        broken.map = (): never => {
            throw new Error("render failed");
        };
        const frame = await renderFrame(
            () => (
                <WithTerminalSize>
                    <PlanCardBlock planId="plan-broken" title="Broken plan" steps={broken} />
                </WithTerminalSize>
            ),
            { width: 80, height: 6 },
        );
        expect(frame).toContain("Fallback step");
        expect(frame).toContain("[scientific-executor]");
    });

    test("shows one grounding line under the plan: the grounded and flagged counts, and the knowledge release", async () => {
        const grounding = (status: string): PlanCardGroundingView => ({
            status,
            snapshot: "sha256:71ac",
            template: "",
            reason: "r",
            rules: [],
            settings: [],
            departures: [],
            sources: [],
        });
        const steps = [{ ...step("A"), grounding: grounding("grounded") }, { ...step("B", ["A"]), grounding: grounding("flagged") }, step("C", ["B"])];

        const frame = await renderFrame(
            () => (
                <WithTerminalSize>
                    <PlanCardBlock planId="plan-1" title="Grounded plan" steps={steps} />
                </WithTerminalSize>
            ),
            { width: 100, height: 30 },
        );

        expect(frame).toContain("grounding: 1 of 3 steps grounded · 1 flagged · knowledge release sha256:71ac");
    });

    test("gives no grounding line to a plan with no grounded step, and counts the releases when the steps name more than one", () => {
        expect(planGroundingLine([step("A"), step("B")])).toBeNull();
        const withRelease = (snapshot: string): PlanCardStepView => ({
            ...step(snapshot),
            grounding: { status: "grounded", snapshot, template: "", reason: "r", rules: [], settings: [], departures: [], sources: [] },
        });
        expect(planGroundingLine([withRelease("sha256:71ac"), withRelease("sha256:ffff")])).toBe("grounding: 2 of 2 steps grounded · 2 knowledge releases");
    });
});
