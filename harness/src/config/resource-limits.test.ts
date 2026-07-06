import { describe, expect, it } from "bun:test";

import { ResourceLimitsConfigError, parseResourcePolicy } from "./resource-limits.js";

describe("parseResourcePolicy", () => {
    const valid = {
        perStep: { maxCpu: 4, maxMemoryGb: 8, maxGpuCount: 0 },
        budget: { cpu: 8, memoryGb: 16 },
    };

    it("accepts a valid policy", () => {
        expect(parseResourcePolicy(valid)).toEqual(valid);
    });

    it("accepts an optional ephemeral spec", () => {
        const policy = { ...valid, ephemeral: { cpu: 2, memoryGb: 4 } };
        expect(parseResourcePolicy(policy)).toEqual(policy);
    });

    it("accepts per-step ceilings equal to the budget", () => {
        const policy = {
            perStep: { maxCpu: 8, maxMemoryGb: 16, maxGpuCount: 0 },
            budget: { cpu: 8, memoryGb: 16 },
        };
        expect(parseResourcePolicy(policy)).toEqual(policy);
    });

    it("rejects a per-step CPU ceiling above the budget", () => {
        const policy = { ...valid, perStep: { maxCpu: 16, maxMemoryGb: 8, maxGpuCount: 0 } };
        expect(() => parseResourcePolicy(policy)).toThrow(ResourceLimitsConfigError);
        expect(() => parseResourcePolicy(policy)).toThrow(/maxCpu/);
    });

    it("rejects a per-step memory ceiling above the budget", () => {
        const policy = { ...valid, perStep: { maxCpu: 4, maxMemoryGb: 32, maxGpuCount: 0 } };
        expect(() => parseResourcePolicy(policy)).toThrow(ResourceLimitsConfigError);
        expect(() => parseResourcePolicy(policy)).toThrow(/maxMemoryGb/);
    });

    it("rejects non-positive budget values", () => {
        expect(() => parseResourcePolicy({ ...valid, budget: { cpu: 0, memoryGb: 16 } })).toThrow(
            ResourceLimitsConfigError,
        );
        expect(() => parseResourcePolicy({ ...valid, budget: { cpu: 8, memoryGb: -1 } })).toThrow(
            ResourceLimitsConfigError,
        );
    });

    it("rejects a structurally invalid policy", () => {
        expect(() => parseResourcePolicy({ budget: { cpu: 8, memoryGb: 16 } })).toThrow(ResourceLimitsConfigError);
        expect(() => parseResourcePolicy(null)).toThrow(ResourceLimitsConfigError);
    });
});
