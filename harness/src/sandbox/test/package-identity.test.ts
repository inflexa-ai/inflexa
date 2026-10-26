import { describe, expect, it } from "bun:test";
import { z } from "zod";

import fixture from "../__fixtures__/package-identity.json" with { type: "json" };
import {
    formatQuery,
    identityAddress,
    identityKey,
    identityOf,
    parseIdentityKey,
    parseQuery,
    pythonIdentity,
    rIdentity,
    resolveQuery,
    type PackageIdentity,
    type PoolIndex,
} from "../package-identity.js";

// The fixture is outside data; the schema gives each entry its real type instead of a cast.
const FixtureTrack = z.enum(["python", "r"]);
const FixtureQuery = z.object({ spelling: z.string(), track: FixtureTrack.optional(), version: z.string().optional() });
const fixtureSchema = z.object({
    parse: z.array(
        z.object({
            entry: z.string(),
            query: FixtureQuery.optional(),
            error: z.string().optional(),
            prefix: z.string().optional(),
            specifier: z.string().optional(),
        }),
    ),
    identity: z.array(z.object({ track: FixtureTrack, input: z.string(), name: z.string(), key: z.string(), address: z.string() })),
    round_trip: z.array(z.object({ query: FixtureQuery, formatted: z.string() })),
});
const conformance = fixtureSchema.parse(fixture);

/**
 * A pool over a fixed list of identities. `rIdentitiesFoldingTo` reads the
 * address of each R identity, thus the suggestion of the ladder comes from the
 * same fold that the store address uses.
 */
function poolOf(identities: readonly PackageIdentity[]): PoolIndex {
    const keys = new Set(identities.map(identityKey));
    return {
        has: (identity) => keys.has(identityKey(identity)),
        rIdentitiesFoldingTo: (fold) => identities.filter((i) => i.track === "r" && identityAddress(i) === fold),
    };
}

describe("package-identity — the conformance fixture", () => {
    it("parses each entry of the fixture", () => {
        for (const entry of conformance.parse) {
            parseQuery(entry.entry).match(
                (query) => {
                    if ("error" in entry) throw new Error(`"${entry.entry}" parsed, and the fixture expects the error "${String(entry.error)}"`);
                    if (entry.query === undefined) throw new Error(`"${entry.entry}" expects a query in the fixture`);
                    expect(query).toEqual(entry.query);
                },
                (issue) => {
                    const expectedError = "error" in entry ? entry.error : undefined;
                    if (expectedError === undefined) throw new Error(`"${entry.entry}" answered the error "${issue.type}", and the fixture expects a query`);
                    expect(expectedError).toBe(issue.type);
                    if ("prefix" in issue && entry.prefix !== undefined) expect(issue.prefix).toBe(entry.prefix);
                    if ("specifier" in issue && entry.specifier !== undefined) expect(issue.specifier).toBe(entry.specifier);
                },
            );
        }
    });

    it("mints the name, the key, and the address of each identity of the fixture", () => {
        for (const entry of conformance.identity) {
            const identity = identityOf(entry.track, entry.input);
            expect(entry.name).toBe(identity.name);
            expect(identityKey(identity)).toBe(entry.key);
            expect(identityAddress(identity)).toBe(entry.address);
        }
    });

    it("round-trips each query of the fixture", () => {
        for (const entry of conformance.round_trip) {
            const query = entry.query;
            expect(formatQuery(query)).toBe(entry.formatted);
            expect(parseQuery(entry.formatted)._unsafeUnwrap()).toEqual(query);
        }
    });
});

describe("package-identity — the two constructors", () => {
    it("a Python identity folds and an R identity keeps its spelling", () => {
        expect("pyyaml").toBe(pythonIdentity("PyYAML").name);
        expect("decoupleR").toBe(rIdentity("decoupleR").name);
    });

    it("a dispatch over an emitted name gives the same identity as the constructor", () => {
        expect(identityKey(identityOf("python", "pyyaml"))).toBe(identityKey(pythonIdentity("PyYAML")));
    });

    it("two identities of one fold keep two keys and share one address", () => {
        const r = rIdentity("decoupleR");
        const python = pythonIdentity("decoupler");

        expect([identityKey(r), identityKey(python)]).toEqual(["r:decoupleR", "python:decoupler"]);
        expect([identityAddress(r), identityAddress(python)]).toEqual(["decoupler", "decoupler"]);
    });

    it("a key round-trips through the parse, and the first colon splits it", () => {
        for (const identity of [rIdentity("GO.db"), rIdentity("decoupleR"), pythonIdentity("scikit_learn")]) {
            expect(parseIdentityKey(identityKey(identity))).toEqual(identity);
        }
    });

    it("a string that is not a key parses to nothing", () => {
        // A bare name, an unknown track, and an empty name each name no
        // identity, thus a reader gets `undefined` and never a half-identity.
        for (const bad of ["igraph", "bioc:fgsea", "python:", ":igraph", ""]) {
            expect(parseIdentityKey(bad)).toBeUndefined();
        }
    });
});

describe("package-identity — the resolution ladder", () => {
    const decoupler = poolOf([rIdentity("decoupleR"), pythonIdentity("decoupler")]);
    const igraph = poolOf([rIdentity("igraph"), pythonIdentity("igraph")]);

    it("an exact R spelling wins over the Python identity of its fold", () => {
        expect(resolveQuery({ spelling: "decoupleR" }, decoupler)).toEqual({ kind: "resolved", identity: rIdentity("decoupleR") });
    });

    it("a folded spelling resolves to the Python identity", () => {
        expect(resolveQuery({ spelling: "decoupler" }, decoupler)).toEqual({ kind: "resolved", identity: pythonIdentity("decoupler") });
    });

    it("one spelling in two tracks is ambiguous", () => {
        expect(resolveQuery({ spelling: "igraph" }, igraph)).toEqual({
            kind: "ambiguous",
            python: pythonIdentity("igraph"),
            r: rIdentity("igraph"),
        });
    });

    it("an R name that is its own fold resolves", () => {
        expect(resolveQuery({ spelling: "dplyr" }, poolOf([rIdentity("dplyr")]))).toEqual({ kind: "resolved", identity: rIdentity("dplyr") });
    });

    it("a Python spelling folds onto its identity", () => {
        expect(resolveQuery({ spelling: "PyYAML" }, poolOf([pythonIdentity("pyyaml")]))).toEqual({ kind: "resolved", identity: pythonIdentity("pyyaml") });
    });

    it("a folded R spelling is unknown with the suggestion", () => {
        expect(resolveQuery({ spelling: "seurat" }, poolOf([rIdentity("Seurat")]))).toEqual({ kind: "unknown", suggestion: rIdentity("Seurat") });
    });

    it("a qualified query reads one track", () => {
        expect(resolveQuery({ spelling: "igraph", track: "r" }, igraph)).toEqual({ kind: "resolved", identity: rIdentity("igraph") });
        expect(resolveQuery({ spelling: "igraph", track: "python" }, igraph)).toEqual({ kind: "resolved", identity: pythonIdentity("igraph") });
    });

    it("a qualified R miss carries the suggestion", () => {
        expect(resolveQuery({ spelling: "seurat", track: "r" }, poolOf([rIdentity("Seurat")]))).toEqual({ kind: "unknown", suggestion: rIdentity("Seurat") });
    });

    it("a name that the pool does not hold is unknown with no suggestion", () => {
        expect(resolveQuery({ spelling: "monocle3" }, decoupler)).toEqual({ kind: "unknown" });
    });

    it("two R spellings of one fold give no suggestion, because a guess between them is a coin flip", () => {
        const two = poolOf([rIdentity("Ambi.Guous"), rIdentity("ambi-guous")]);

        expect(resolveQuery({ spelling: "AMBI_GUOUS" }, two)).toEqual({ kind: "unknown" });
    });

    it("the version of a query takes no part in the resolution", () => {
        expect(resolveQuery({ spelling: "decoupleR", version: "2.17.0" }, decoupler)).toEqual({ kind: "resolved", identity: rIdentity("decoupleR") });
    });
});
