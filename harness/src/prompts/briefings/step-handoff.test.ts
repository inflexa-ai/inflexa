import { describe, expect, it } from "bun:test";

import { composeBriefing } from "./compose.js";
import { stepHandoffBriefing } from "./step-handoff.js";
import { stepHandoffFixture, stepHandoffSingleArtifactFixture } from "./step-handoff.fixture.js";

describe("stepHandoffBriefing", () => {
    it("renders its fixture in isolation, matching the snapshot", () => {
        const rendered = stepHandoffBriefing.render(stepHandoffFixture);

        // No I/O — a pure render from the colocated fixture.
        expect(rendered.content).toMatchSnapshot();
        expect(rendered.caption).toMatchSnapshot();
    });

    it("captions with the upstream step id, name, and artifact count", () => {
        const { caption } = stepHandoffBriefing.render(stepHandoffFixture);
        expect(caption).toBe('step s2 "normalize" · 4 artifacts');
    });

    it("embeds the interpretation summary verbatim", () => {
        const { content } = stepHandoffBriefing.render(stepHandoffFixture);
        expect(content).toContain(stepHandoffFixture.summaryMarkdown);
    });

    it("lists every artifact path as a sandbox-canonical location", () => {
        const { content } = stepHandoffBriefing.render(stepHandoffFixture);
        for (const path of stepHandoffFixture.artifactPaths) {
            expect(content).toContain(path);
            expect(path.startsWith("/analysis_ad01/")).toBe(true);
        }
    });

    it("does not list the upstream summary.md as an artifact", () => {
        const { content } = stepHandoffBriefing.render(stepHandoffFixture);
        // summary.md is the briefing body, not a pointer — never a listed artifact.
        expect(content).not.toContain("summary.md");
    });

    it("leaks no host filesystem path into the content", () => {
        const { content } = stepHandoffBriefing.render(stepHandoffFixture);
        expect(content).not.toContain("/home/");
        expect(content).not.toContain("/tmp/");
        // Every rendered artifact bullet is under the sandbox analysis namespace.
        for (const line of content.split("\n").filter((l) => l.startsWith("- /"))) {
            expect(line.startsWith("- /analysis_ad01/")).toBe(true);
        }
    });

    it("uses the singular `artifact` for a one-artifact upstream", () => {
        const { caption } = stepHandoffBriefing.render(stepHandoffSingleArtifactFixture);
        expect(caption).toBe('step s1 "qc" · 1 artifact');
    });

    it("renders deterministically across calls", () => {
        const a = stepHandoffBriefing.render(stepHandoffFixture);
        const b = stepHandoffBriefing.render(stepHandoffFixture);
        expect(a).toEqual(b);
    });

    it("is a standing briefing", () => {
        expect(stepHandoffBriefing.mode).toBe("standing");
    });

    it('composes into a single user <briefing name="step-handoff"> message', () => {
        const composed = composeBriefing(stepHandoffBriefing, stepHandoffFixture);
        expect(composed.name).toBe("step-handoff");
        expect(composed.message.role).toBe("user");
        const text = composed.message.content as string;
        expect(text.startsWith('<briefing name="step-handoff">')).toBe(true);
        expect(text.endsWith("</briefing>")).toBe(true);
    });
});
