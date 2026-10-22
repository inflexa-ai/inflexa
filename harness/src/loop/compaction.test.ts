import { describe, expect, it } from "bun:test";

import { rulesForContextWindow } from "./compaction.js";

describe("rulesForContextWindow", () => {
    const rules = { turnStartBudget: 150_000, budget: 200_000 };

    it("keeps the declared rules when the window is absent or 80% of it is at least the budget", () => {
        expect(rulesForContextWindow(rules, undefined)).toBe(rules);
        expect(rulesForContextWindow(rules, 1_000_000)).toBe(rules);
        expect(rulesForContextWindow(rules, 250_000)).toBe(rules);
    });

    it("caps the budget at 80% of a smaller window, and keeps the ratio of the turn-start budget", () => {
        expect(rulesForContextWindow(rules, 40_960)).toEqual({ budget: 32_768, turnStartBudget: 24_576 });
    });

    it("caps a budget with no turn-start budget", () => {
        expect(rulesForContextWindow({ budget: 250_000 }, 128_000)).toEqual({ budget: 102_400 });
    });
});
