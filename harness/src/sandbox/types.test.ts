import { describe, expect, test } from "bun:test";

import { shelfKey } from "./types.js";

describe("shelfKey", () => {
    test("a Python name folds to its PEP 503 form", () => {
        expect(shelfKey("python", "Decoupler")).toBe("decoupler");
        expect(shelfKey("python", "Typing_Ext")).toBe("typing-ext");
        expect(shelfKey("python", "PyYAML")).toBe("pyyaml");
    });

    test("an R name stays verbatim, because library() is case-sensitive", () => {
        expect(shelfKey("r", "decoupleR")).toBe("decoupleR");
        expect(shelfKey("r", "GO.db")).toBe("GO.db");
        expect(shelfKey("r", "Seurat")).toBe("Seurat");
    });

    test("the two tracks keep one spelling apart", () => {
        expect(shelfKey("python", "decoupler")).not.toBe(shelfKey("r", "decoupleR"));
    });
});
