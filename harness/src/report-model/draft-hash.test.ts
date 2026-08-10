/**
 * The draft hash, over a JSON serialization with sorted keys.
 *
 * The look-before-record markers ride two hashes of one draft. A marker survives a round trip through
 * storage, thus the hash must not depend on key order. These tests cover the sort invariance and the
 * sensitivity to a real change.
 */

import { describe, expect, it } from "bun:test";

import type { DraftDocument } from "./draft.js";
import { computeDraftHash } from "./draft-hash.js";

describe("computeDraftHash", () => {
    it("gives one hash for two key orders of one draft", () => {
        const canonical: DraftDocument = {
            title: "A report",
            sections: [{ kind: "section", id: "s1", title: "Findings", blocks: [{ kind: "text", id: "t1", content: { prose: "A finding." } }] }],
        };
        // The same draft with each object's keys in a different source order. A round trip through storage
        // reorders keys, thus the two must hash the same.
        const reordered = {
            sections: [{ blocks: [{ content: { prose: "A finding." }, id: "t1", kind: "text" }], title: "Findings", id: "s1", kind: "section" }],
            title: "A report",
        } as DraftDocument;

        expect(computeDraftHash(reordered)).toBe(computeDraftHash(canonical));
    });

    it("gives a different hash for a changed value", () => {
        const base: DraftDocument = {
            title: "A report",
            sections: [{ kind: "section", id: "s1", title: "Findings", blocks: [{ kind: "text", id: "t1", content: { prose: "A finding." } }] }],
        };
        const changed: DraftDocument = {
            title: "A report",
            sections: [{ kind: "section", id: "s1", title: "Findings", blocks: [{ kind: "text", id: "t1", content: { prose: "A different finding." } }] }],
        };

        expect(computeDraftHash(changed)).not.toBe(computeDraftHash(base));
    });

    it("gives a stable hex digest of the whole draft", () => {
        const draft: DraftDocument = { title: "", sections: [] };
        const hash = computeDraftHash(draft);
        // A sha256 digest is 64 hex characters. The hash is deterministic, thus a second call gives the same.
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(computeDraftHash(draft)).toBe(hash);
    });
});
