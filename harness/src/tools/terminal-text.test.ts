import { describe, expect, it } from "bun:test";

import { degenerateTerminalText } from "./terminal-text.js";

describe("degenerateTerminalText", () => {
    it("refuses a placeholder, a short text, and a filler word, and accepts a real question", () => {
        expect(degenerateTerminalText("Placeholder — not used.")).toContain("placeholder");
        expect(degenerateTerminalText("placeholder")).toBeDefined();
        expect(degenerateTerminalText("skip")).toBeDefined();
        expect(degenerateTerminalText("   ")).toBeDefined();
        expect(degenerateTerminalText("TODO: fill in the reason for the user later")).toContain("placeholder");
        expect(degenerateTerminalText("Which two conditions should be contrasted?")).toBeUndefined();
        expect(
            degenerateTerminalText(
                "The inputs are FASTQ files and no count matrix exists; which quantifier produced the counts, or can the counts be provided?",
            ),
        ).toBeUndefined();
    });
});
