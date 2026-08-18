/**
 * The vocabulary separation is the enforcement, so it is tested as such.
 *
 * A scan that handed the agent a field named `kinds` and then asked it to author
 * `kinds` would be asking it to ratify a machine's guess, and ratification is
 * indistinguishable from judgement in the output. These tests fail the moment the
 * manifest starts speaking the profile's language.
 */

import { describe, expect, it } from "bun:test";

import { ProfilerOutputSchema } from "../schemas/data-profile-schemas.js";
import { buildManifest } from "./scan.js";
import type { InputScanManifest, ScannedFile } from "./types.js";

function file(path: string): ScannedFile {
    return { path, size: 10, extensions: ["vcf", "gz"], format: "vcf", wrapper: "bgzip" };
}

function keysDeep(value: unknown, out: Set<string> = new Set()): Set<string> {
    if (Array.isArray(value)) {
        for (const item of value) keysDeep(item, out);
        return out;
    }
    if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
            out.add(key);
            keysDeep(child, out);
        }
    }
    return out;
}

const manifest: InputScanManifest = buildManifest(
    "data/inputs",
    Array.from({ length: 12 }, (_, i) => file(`data/inputs/S${String(i + 1).padStart(3, "0")}.vcf.gz`)),
    false,
).manifest;

describe("the manifest speaks the scan's vocabulary only", () => {
    it("carries no field named kinds or axes", () => {
        const keys = keysDeep(manifest);
        expect(keys.has("kinds")).toBe(false);
        expect(keys.has("axes")).toBe(false);
        expect(keys.has("shapes")).toBe(true);
        expect(keys.has("variablePositions")).toBe(true);
    });

    it("is not shaped so that copying it constitutes a profile", () => {
        const asProfile = ProfilerOutputSchema.safeParse(manifest);
        expect(asProfile.success).toBe(false);

        // Nor does any single field of it satisfy the profile's kinds contract: a shape
        // carries no statement of what one member represents, because the scan cannot
        // make one.
        const kindsFromShapes = ProfilerOutputSchema.shape.kinds.safeParse(manifest.shapes);
        expect(kindsFromShapes.success).toBe(false);
    });

    it("presents shapes as observations of name structure", () => {
        const shape = manifest.shapes[0]!;
        expect(shape.pattern).toContain("<");
        expect(shape.variablePositions[0]!.sampleValues.length).toBeGreaterThan(0);
        expect(Object.keys(shape)).not.toContain("memberRepresents");
    });
});
