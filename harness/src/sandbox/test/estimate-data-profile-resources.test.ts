import { describe, expect, it } from "bun:test";
import { DATA_PROFILE_RESOURCES } from "../estimate-data-profile-resources.js";

describe("DATA_PROFILE_RESOURCES", () => {
    it("is a small fixed size, independent of the input bytes", () => {
        expect(DATA_PROFILE_RESOURCES).toEqual({ cpu: 2, memoryGb: 4 });
    });
});
