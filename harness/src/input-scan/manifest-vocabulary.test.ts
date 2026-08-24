/**
 * The vocabulary separation is the enforcement, so it is tested as such.
 *
 * A scan that handed the agent a field named `groups` and then asked it to author
 * `groups` would be asking it to ratify a machine's guess, and ratification is
 * indistinguishable from judgement in the output. These tests fail the moment the
 * scan starts speaking the profile's language.
 */

import { describe, expect, it } from "bun:test";

import { ProfileSubmissionSchema } from "../schemas/data-profile-schemas.js";
import { detectSets } from "./detect-sets.js";
import { buildSetMenu } from "./menu.js";
import { buildManifest } from "./scan.js";
import type { InputScanManifest, ScannedFile } from "./types.js";

function file(path: string): ScannedFile {
    return { path, size: 10, extensions: ["vcf", "gz"], format: "vcf", wrapper: "bgzip" };
}

function keysDeep(value: unknown, out: Set<string> = new Set()): Set<string> {
    if (value instanceof Map) {
        for (const item of value.values()) keysDeep(item, out);
        return out;
    }
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

const files = Array.from({ length: 12 }, (_, i) => file(`data/inputs/S${String(i + 1).padStart(3, "0")}.vcf.gz`));
const manifest: InputScanManifest = buildManifest("data/inputs", files, false).manifest;
const menu = buildSetMenu(detectSets(files));

describe("the scan speaks its own vocabulary only", () => {
    it("names no groups, dimensions, kinds, or axes", () => {
        for (const keys of [keysDeep(manifest), keysDeep(menu)]) {
            expect(keys.has("groups")).toBe(false);
            expect(keys.has("dimensions")).toBe(false);
            expect(keys.has("kinds")).toBe(false);
            expect(keys.has("axes")).toBe(false);
        }
        expect(keysDeep(menu).has("slots")).toBe(true);
        expect(keysDeep(manifest).has("shapes")).toBe(true);
    });

    it("is not shaped so that copying it constitutes a profile", () => {
        expect(ProfileSubmissionSchema.safeParse(menu).success).toBe(false);

        // Nor does any single field of it satisfy the authoring contract: a set carries
        // no statement of what one member represents, because the scan cannot make one.
        expect(ProfileSubmissionSchema.shape.operations.safeParse(menu.sets).success).toBe(false);
    });

    it("presents sets as observations of path structure", () => {
        const set = menu.sets[0]!;
        expect(set.pathTemplate).toContain("<");
        expect(set.slots[0]!.sampleValues.length).toBeGreaterThan(0);
        expect(Object.keys(set)).not.toContain("memberRepresents");
    });
});
