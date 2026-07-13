import { describe, expect, it } from "bun:test";

import { composeBriefing } from "./compose.js";
import { priorRunsBriefing } from "./prior-runs.js";
import { priorRunsFixture, priorRunsOverCapFixture, priorRunsStepLessFixture } from "./prior-runs.fixture.js";

describe("priorRunsBriefing", () => {
    it("renders its fixture in isolation, matching the snapshot", () => {
        const rendered = priorRunsBriefing.render(priorRunsFixture);

        // No I/O — a pure render from the colocated fixture.
        expect(rendered.content).toMatchSnapshot();
        expect(rendered.caption).toMatchSnapshot();
    });

    it("captions with count, latest run outcome, and completion date", () => {
        const { caption } = priorRunsBriefing.render(priorRunsFixture);
        expect(caption).toBe("2 prior runs · latest run_8f3a 6/7 steps · 2026-07-10");
    });

    it("indexes each terminal run with id, title, outcomes, and failed step names", () => {
        const { content } = priorRunsBriefing.render(priorRunsFixture);
        expect(content).toContain("**run_8f3a** — AD lesional vs control DE + pathways");
        expect(content).toContain("6/7 steps completed, failed: qc_step");
        expect(content).toContain("**run_2b1c** — Bulk RNA-seq differential expression");
    });

    it("carries no synthesis body or step-summary text — pointers only", () => {
        const { content } = priorRunsBriefing.render(priorRunsFixture);
        expect(content).not.toContain("synthesis.json");
        expect(content).not.toContain("summary.md");
        // No findings/interpretation prose leaks into the index.
        expect(content.toLowerCase()).not.toContain("finding");
    });

    it("ends with the just-in-time inspect_run retrieval nudge", () => {
        const { content } = priorRunsBriefing.render(priorRunsFixture);
        const lastLine = content.trimEnd().split("\n").at(-1)!;
        expect(lastLine).toContain("inspect_run");
    });

    it("closes an over-cap history with an explicit older-runs line", () => {
        const { content, caption } = priorRunsBriefing.render(priorRunsOverCapFixture);
        expect(content).toContain("…and 3 older runs");
        // The truncation line precedes the nudge; the nudge is still last.
        expect(content.trimEnd().split("\n").at(-1)!).toContain("inspect_run");
        expect(caption).toBe("10 prior runs · latest run_0010 3/3 steps · 2026-07-10");
    });

    it("renders no older-runs line for an under-cap history", () => {
        const { content } = priorRunsBriefing.render(priorRunsFixture);
        expect(content).not.toContain("older run");
    });

    it("degrades a plan-less, step-less run gracefully", () => {
        const { content, caption } = priorRunsBriefing.render(priorRunsStepLessFixture);
        expect(content).toContain("**run_ep01** — run_ephemeral");
        expect(content).toContain("no steps recorded");
        expect(caption).toBe("1 prior run · latest run_ep01 0/0 steps · 2026-07-11");
    });

    it("renders deterministically across calls", () => {
        const a = priorRunsBriefing.render(priorRunsFixture);
        const b = priorRunsBriefing.render(priorRunsFixture);
        expect(a).toEqual(b);
    });

    it("is a standing briefing", () => {
        expect(priorRunsBriefing.mode).toBe("standing");
    });

    it('composes into a single user <briefing name="prior-runs"> message', () => {
        const composed = composeBriefing(priorRunsBriefing, priorRunsFixture);
        expect(composed.name).toBe("prior-runs");
        expect(composed.message.role).toBe("user");
        const text = composed.message.content as string;
        expect(text.startsWith('<briefing name="prior-runs">')).toBe(true);
        expect(text.endsWith("</briefing>")).toBe(true);
    });
});
