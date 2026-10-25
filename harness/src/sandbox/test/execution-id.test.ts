import { describe, expect, test } from "bun:test";

import { AGENT_NAME_MAX_LENGTH, sanitizeAgentName } from "../execution-id.js";

describe("sanitizeAgentName", () => {
    test("keeps an internal dash as one dash", () => {
        expect(sanitizeAgentName("table-deriver")).toBe("table-deriver");
    });

    test("strips a trailing dash", () => {
        expect(sanitizeAgentName("a-")).toBe("a");
    });

    test("collapses a dash run to one dash", () => {
        expect(sanitizeAgentName("a--b")).toBe("a-b");
    });

    test("turns dropped characters between letters into one dash", () => {
        expect(sanitizeAgentName("a b")).toBe("a-b");
        expect(sanitizeAgentName("a . -b")).toBe("a-b");
    });

    test("strips leading and trailing junk", () => {
        expect(sanitizeAgentName("--a-b--")).toBe("a-b");
        expect(sanitizeAgentName("...")).toBe("");
    });

    test("lowercases", () => {
        expect(sanitizeAgentName("QC Agent")).toBe("qc-agent");
    });

    test("truncates to the 40-character name cap", () => {
        expect(sanitizeAgentName("a".repeat(45))).toBe("a".repeat(AGENT_NAME_MAX_LENGTH));
        expect(sanitizeAgentName("a-b".repeat(20)).length).toBeLessThanOrEqual(AGENT_NAME_MAX_LENGTH);
    });
});
