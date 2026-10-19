/**
 * Live PubChem PUG-REST contract check.
 *
 * The property table arrives with the molecular weight as a string, thus the
 * schema reads it through the wire-number helper. One real request proves that
 * the live payload still passes the schema and maps to a number.
 *
 * Gated on `CORTEX_LIVE_API_TESTS`. Without the gate the block runs on each
 * clean checkout, and the suite then depends on the network.
 */

import { describe, expect, test } from "bun:test";

import { getCompoundPropertiesByCID } from "../../../tools/lib/pubchem-client.js";
import { must } from "@inflexa-ai/harness/lib/test/guards.js";

const LIVE = process.env.CORTEX_LIVE_API_TESTS;

/** Aspirin. The fixture corpus captures the same identifier. */
const ASPIRIN_CID = 2244;

/** One upper-case ASCII letter run: `A`-`Z`, and the value is not empty. */
function isUpperAlpha(value: string): boolean {
    if (value.length === 0) return false;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 65 || code > 90) return false;
    }
    return true;
}

/** The InChIKey layout: 14 upper-case letters, a hyphen, 10 upper-case letters, a hyphen, one upper-case letter. */
function isInchiKeyLayout(value: string): boolean {
    return (
        value.length === 27 &&
        isUpperAlpha(value.slice(0, 14)) &&
        value[14] === "-" &&
        isUpperAlpha(value.slice(15, 25)) &&
        value[25] === "-" &&
        isUpperAlpha(value.slice(26))
    );
}

describe.skipIf(!LIVE)("live PubChem", () => {
    test("the property schema accepts the live payload for a canonical CID", async () => {
        const props = must(await getCompoundPropertiesByCID(ASPIRIN_CID), "props");

        expect(props).not.toBe(null);
        expect(props.cid).toBe(ASPIRIN_CID);
        expect(typeof props.molecularWeight).toBe("number");
        expect(typeof props.inchiKey === "string" && isInchiKeyLayout(props.inchiKey)).toBe(true);
        expect(props).toHaveProperty("canonicalSmiles");
    }, 60_000);
});
