import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { showUserTool } from "../show-user.js";

describe("show_user input schema", () => {
    it("carries no $ref and no $defs, because the recursive json schema does not reach every model backend", () => {
        const text = JSON.stringify(z.toJSONSchema(showUserTool.inputSchema));
        expect(text).not.toContain("$ref");
        expect(text).not.toContain("$defs");
    });

    it("still reads the spec as an object", () => {
        expect(showUserTool.inputSchema.safeParse({ kind: "echart", spec: { series: [] } }).success).toBe(true);
        expect(showUserTool.inputSchema.safeParse({ kind: "echart", spec: "not an object" }).success).toBe(false);
    });
});
