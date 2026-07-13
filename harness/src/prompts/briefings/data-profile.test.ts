import { describe, expect, it } from "bun:test";

import { composeBriefing, wrapBriefingContent } from "./compose.js";
import { dataProfileBriefing } from "./data-profile.js";
import { dataProfileFixture } from "./data-profile.fixture.js";
import type { BriefingDefinition } from "./types.js";

describe("dataProfileBriefing", () => {
    it("renders its fixture in isolation, matching the snapshot", () => {
        const rendered = dataProfileBriefing.render(dataProfileFixture);

        // No I/O — a pure render from the colocated fixture.
        expect(rendered.content).toMatchSnapshot();
        expect(rendered.caption).toMatchSnapshot();
    });

    it("captions with file count, format kinds, and profile version", () => {
        const { caption } = dataProfileBriefing.render(dataProfileFixture);
        expect(caption).toBe("3 files · CSV, TSV, VCF · profiled 2026-06-09 10:00");
    });

    it("renders deterministically across calls", () => {
        const a = dataProfileBriefing.render(dataProfileFixture);
        const b = dataProfileBriefing.render(dataProfileFixture);
        expect(a).toEqual(b);
    });

    it("is a standing briefing", () => {
        expect(dataProfileBriefing.mode).toBe("standing");
    });
});

describe("briefing composition (injection path)", () => {
    it("wraps rendered content in a single user <briefing> message", () => {
        const composed = composeBriefing(dataProfileBriefing, dataProfileFixture);

        expect(composed.name).toBe("data-profile");
        expect(composed.message.role).toBe("user");
        const text = composed.message.content as string;
        expect(text.startsWith('<briefing name="data-profile">')).toBe(true);
        expect(text.endsWith("</briefing>")).toBe(true);
        // The definition carries plain content; the wrapper lives here only.
        expect(dataProfileBriefing.render(dataProfileFixture).content).not.toContain("<briefing");
        expect(text).toContain(wrapBriefingContent("data-profile", dataProfileBriefing.render(dataProfileFixture).content));
    });
});

// Rolling mode is representable in the contract (this asserts it) but has no
// working-memory / analysis-context retrofit yet — that is a follow-up change.
describe("rolling mode is representable but unused", () => {
    const rollingBriefing: BriefingDefinition<{ note: string }> = {
        name: "scratch",
        description: "A per-turn scratch note.",
        mode: "rolling",
        render: (input) => ({ content: input.note, caption: input.note.slice(0, 20) }),
    };

    it("composes a rolling briefing into a tail-ready user message", () => {
        expect(rollingBriefing.mode).toBe("rolling");
        const composed = composeBriefing(rollingBriefing, { note: "remember X" });
        expect(composed.message.role).toBe("user");
        expect(composed.message.content).toBe('<briefing name="scratch">\nremember X\n</briefing>');
    });
});
