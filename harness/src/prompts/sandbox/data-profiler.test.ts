/**
 * The profiler prompt carries three things nothing else can enforce: the substrate test in
 * the words the decision ledger settled on, the catalogues the submit schema validates
 * against, and the stance that an empty answer is a complete one. A drift in any of them is
 * invisible until a profile comes back wrong, so they are asserted here.
 */

import { describe, expect, it } from "bun:test";

import { z } from "zod";

import { DIMENSION_CATEGORIES, DIMENSION_PROBE_IDS, GROUP_CATEGORY_IDS, GROUP_ROLE_IDS, PROBE_OUTCOME_IDS } from "../../contracts/profile-vocabulary.js";
import { ProfileSubmissionSchema } from "../../schemas/data-profile-schemas.js";
import { dataProfilerPrompt } from "./data-profiler.js";

/** Collapse wrapping and blockquote markers, so a verbatim carry survives being re-wrapped. */
function flatten(text: string): string {
    return text
        .replace(/^\s*>\s?/gm, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** The substrate test as the design ledger states it. */
const SUBSTRATE_TEST = flatten(`
**Would a downstream step typically consume one value's files as a different
substrate than another's?** Yes → split the set into groups (somatic/germline,
tumor/normal). No — the values are variants of the same substrate → keep it a
slot, possibly bound to a dimension (caller, lane, read pair, chromosome shard,
replicate). Identity slots (high-cardinality IDs) are never split.
`);

const flat = flatten(dataProfilerPrompt);

describe("the substrate test", () => {
    it("appears verbatim", () => {
        expect(flat).toContain(SUBSTRATE_TEST);
    });

    it("is stated as typically, never as ever", () => {
        expect(flat).toContain('"Typically", not "ever"');
    });
});

describe("the catalogues render from the shipped vocabulary", () => {
    it("names every group role", () => {
        for (const role of GROUP_ROLE_IDS) expect(dataProfilerPrompt).toContain(`\`${role}\``);
    });

    it("names every group category", () => {
        for (const category of GROUP_CATEGORY_IDS) expect(dataProfilerPrompt).toContain(`\`${category}\``);
    });

    it("gives every dimension category its default treatment", () => {
        for (const entry of DIMENSION_CATEGORIES) {
            expect(dataProfilerPrompt).toContain(`\`${entry.id}\` (DEFAULT: ${entry.defaultTreatment})`);
        }
    });

    it("renders the definitions rather than a hand-copied list", () => {
        for (const entry of DIMENSION_CATEGORIES) expect(flat).toContain(flatten(entry.definition));
    });
});

describe("the probe list", () => {
    it("names every probe", () => {
        for (const probe of DIMENSION_PROBE_IDS) expect(dataProfilerPrompt).toContain(`\`${probe}\``);
    });

    it("names all four outcomes", () => {
        for (const outcome of PROBE_OUTCOME_IDS) expect(dataProfilerPrompt).toContain(`\`${outcome}\``);
    });

    it("bounds what a not-found must have searched", () => {
        expect(flat).toContain("valid only when `searched` names the files above");
        expect(flat).toContain("up to about ten files");
    });
});

describe("the no-forcing stance", () => {
    it("says outright that an empty answer is correct", () => {
        expect(flat).toContain("An empty `dimensions` list is a correct and complete answer");
        expect(flat).toContain('"Not found after looking" is a correct, complete answer');
    });

    it("forbids applying every category", () => {
        expect(flat).toContain("Apply every category");
        expect(flat).toContain("never a checklist to fill");
        expect(flat).not.toMatch(/dimension for (each|every) categor/i);
    });

    it("forbids exhaustive column hunts off the probe list", () => {
        expect(flat).toContain("Hunt exhaustively through columns for dimensions off the probe list");
    });
});

describe("reasons and orientation", () => {
    it("requires a reason for every split, merge, and category deviation", () => {
        expect(flat).toContain("every `split`");
        expect(flat).toContain("every `merge`");
        expect(flat).toContain("every deviation from a category's default treatment");
    });

    it("orients from the menu rather than from an enumeration of the tree", () => {
        expect(flat).toContain("The menu is your orientation pass");
        expect(flat).toContain("listing the tree yourself only rediscovers what you were handed");
    });

    it("states that a re-scan informs but does not become addressable", () => {
        expect(flat).toContain("`scan_inputs`");
        expect(flat).toContain("no id from a re-scan is addressable");
        expect(flat).toContain("`list_files`");
    });

    it("keeps the QC prohibition intact", () => {
        expect(flat).toContain("You do NOT perform quality control");
        expect(flat).toContain("transition/transversion");
        expect(flat).toContain("principal-component outlier");
    });

    it("carries no kinds-or-axes-era language", () => {
        expect(flat).not.toMatch(/\bkinds\b/);
        expect(flat).not.toMatch(/\baxes\b/);
        expect(flat).not.toMatch(/qualityAssessment/);
    });
});

/**
 * Every property name anywhere in the submission schema. Collected from the emitted JSON
 * Schema rather than the Zod object, so a nested rename is caught without this test
 * knowing the shape's structure.
 */
function schemaFieldNames(node: unknown, into: Set<string> = new Set()): Set<string> {
    if (Array.isArray(node)) {
        for (const entry of node) schemaFieldNames(entry, into);
        return into;
    }
    if (node === null || typeof node !== "object") return into;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "properties" && value !== null && typeof value === "object") {
            for (const property of Object.keys(value as Record<string, unknown>)) into.add(property);
        }
        schemaFieldNames(value, into);
    }
    return into;
}

describe("the prompt names the submission's fields as the schema spells them", () => {
    const fields = schemaFieldNames(z.toJSONSchema(ProfileSubmissionSchema));

    it("uses a real field name for every camelCase token it quotes", () => {
        const quoted = [...new Set(dataProfilerPrompt.match(/`[a-z]+[A-Z][A-Za-z]*`/g) ?? [])].map((token) => token.slice(1, -1));

        expect(quoted.length).toBeGreaterThan(0);
        for (const token of quoted) expect(fields.has(token), `prompt quotes \`${token}\`, which the submission schema does not carry`).toBe(true);
    });

    it("uses the schema's own plural for every list field it names", () => {
        for (const field of ["operations", "dimensions", "probes", "reconciliations", "caveats", "memberAnnotations", "accessions"]) {
            expect(fields.has(field), field).toBe(true);
            expect(flat, field).toContain(`\`${field}\``);
        }
    });

    it("never quotes the singular of a list field, which is what a reader would then look for", () => {
        for (const near of ["reconciliation", "operation", "caveat", "accession", "memberAnnotation", "observation"]) {
            expect(fields.has(near), near).toBe(false);
            expect(flat, near).not.toContain(`\`${near}\``);
        }
    });
});
