import { describe, expect, it } from "bun:test";

import { plannerPrompt } from "./planner.js";

describe("plannerPrompt — the packages of each step", () => {
    it("the prompt names the prefix", () => {
        // The spec scenario of the same name. The census marks a both-track
        // name with the two forms, and this section is what turns that mark
        // into the string the planner writes.
        const prompt = plannerPrompt("- agent-a: does a thing");

        expect(prompt).toContain("under a Python section AND under an R");
        expect(prompt).toContain('"python:igraph"');
        expect(prompt).toContain('"r:igraph"');
        expect(prompt).toContain("A bare name that both tracks hold refuses the launch");
    });
});
