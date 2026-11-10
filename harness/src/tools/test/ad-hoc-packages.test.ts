import { describe, expect, it } from "bun:test";

import { createNoopLogger } from "../../lib/console-logger.js";
import { validateAdHocPackages } from "../ad-hoc-packages.js";

const logger = createNoopLogger();

describe("the packages of an ad hoc step", () => {
    it("keeps each entry that parses", async () => {
        const result = await validateAdHocPackages(["scanpy", "python:igraph"], undefined, logger);

        expect(result).toEqual({ packages: ["scanpy", "python:igraph"], droppedPackages: [] });
    });

    it("drops an entry that is not a query", async () => {
        const result = await validateAdHocPackages(["rdkit", "./wheels/rdkit-2024.9.1.whl"], undefined, logger);

        expect(result.packages).toEqual(["rdkit"]);
        expect(result.droppedPackages).toEqual([{ entry: "./wheels/rdkit-2024.9.1.whl", reason: "unparsable" }]);
    });

    it("keeps a present name, rewrites a missed spelling once, and drops a name the pool does not hold", async () => {
        const result = await validateAdHocPackages(
            ["scanpy", "seurat", "SEURAT", "r:seurat==5.0.0", "MOFA2"],
            (names) =>
                Promise.resolve(
                    names.map((requested) =>
                        requested === "scanpy"
                            ? { requested, present: true as const, name: "scanpy", section: "Python (pip)", version: "1.10.0" }
                            : requested === "MOFA2"
                              ? { requested, present: false as const }
                              : { requested, present: false as const, suggestion: "Seurat" },
                    ),
                ),
            logger,
        );

        // Only the spelling missed, thus the rewrite keeps the track and the
        // version of the ask. Two entries that take one spelling are one ask,
        // and the step must not name that package twice.
        expect(result.packages).toEqual(["scanpy", "Seurat", "r:Seurat==5.0.0"]);
        expect(result.droppedPackages).toEqual([{ entry: "MOFA2", reason: "absent" }]);
    });

    it("keeps every parsed entry when the resolution cannot answer", async () => {
        const unavailable = await validateAdHocPackages(["scanpy", "MOFA2"], () => Promise.resolve(null), logger);
        const throwing = await validateAdHocPackages(["scanpy"], () => Promise.reject(new Error("inventory down")), logger);

        // An inventory that cannot answer says nothing about a package, thus
        // the link pass judges every entry at launch.
        expect(unavailable).toEqual({ packages: ["scanpy", "MOFA2"], droppedPackages: [] });
        expect(throwing).toEqual({ packages: ["scanpy"], droppedPackages: [] });
    });
});
