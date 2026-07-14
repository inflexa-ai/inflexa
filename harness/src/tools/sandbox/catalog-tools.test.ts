import { describe, expect, it } from "bun:test";

import { parsePackagesFile, queryPackages } from "./list-available-packages.js";
import { queryRefs, type Registry, type RegistryEntry } from "./list-available-refs.js";

// A faithful slice of `/mnt/libs/current/packages.txt`: the two `#` advisory
// lines the producers emit, then `## <Section>` headings each followed by one
// comma-separated line of names. The real file carries NO version strings.
const PACKAGES_TXT = `# Available packages in the sandbox environment.
# Do NOT attempt to install packages — there is no network access and no build toolchain.

## R (CRAN)
Seurat, dplyr, ggplot2

## R (Bioconductor)
DESeq2, edgeR, limma

## Python (pip)
anndata, scanpy, pydeseq2

## System tools (CLI)
bcftools, samtools

## Node (npm)
typescript
`;

const SECTIONS = parsePackagesFile(PACKAGES_TXT);

function entry(local_path: string, over: Partial<RegistryEntry> = {}): RegistryEntry {
    return {
        local_path,
        sha256: "abc",
        bytes: 1,
        rows: null,
        category: null,
        subtype: null,
        organism: null,
        tax_id: null,
        dataset: null,
        endpoint: null,
        ...over,
    };
}

const REGISTRY: Registry = {
    registry_version: "1",
    build_id: "build-1",
    generated_at: "2026-01-01",
    files: {
        by_category: {
            atlas_singlecell: [
                entry("atlas_singlecell/pan_t.h5ad", { organism: "human", dataset: "Zheng 2021" }),
                entry("atlas_singlecell/pan_myeloid.rds", { organism: "human" }),
            ],
            msigdb: [entry("msigdb/h.all.gmt", { rows: 50 }), entry("msigdb/c2.cp.gmt"), entry("msigdb/c5.go.gmt")],
            gene_mappings: [entry("gene_mappings/orthologs_9606.parquet", { tax_id: "9606" })],
        },
    },
    summary: { total_output_files: 6, categories: ["atlas_singlecell", "msigdb", "gene_mappings"] },
};

describe("parsePackagesFile", () => {
    it("splits the real packages.txt shape into per-track sections of names", () => {
        expect(SECTIONS.map((s) => s.title)).toEqual(["R (CRAN)", "R (Bioconductor)", "Python (pip)", "System tools (CLI)", "Node (npm)"]);
        expect(SECTIONS[0]!.packages).toEqual(["Seurat", "dplyr", "ggplot2"]);
        expect(SECTIONS[3]!.packages).toEqual(["bcftools", "samtools"]);
    });

    it("ignores the `#` advisory header lines", () => {
        expect(SECTIONS.flatMap((s) => s.packages).some((p) => p.startsWith("#"))).toBe(false);
    });
});

describe("queryPackages — names (presence check)", () => {
    it("reports present/absent plus the language track, without returning the catalog", () => {
        const result = queryPackages(SECTIONS, { names: ["Seurat", "scanpy", "monocle3"] });
        if (!result.available || !("checked" in result)) throw new Error("expected a checked result");

        expect(result.checked).toEqual([
            { requested: "Seurat", present: true, name: "Seurat", section: "R (CRAN)" },
            { requested: "scanpy", present: true, name: "scanpy", section: "Python (pip)" },
            { requested: "monocle3", present: false },
        ]);
        // The whole point: a presence check does not carry the package listing.
        expect(result).not.toHaveProperty("content");
    });

    it("matches case-insensitively but echoes the catalog's canonical spelling", () => {
        const result = queryPackages(SECTIONS, { names: ["seurat", "DESEQ2"] });
        if (!result.available || !("checked" in result)) throw new Error("expected a checked result");

        // R names are case-sensitive at `library()` — the caller needs the exact one.
        expect(result.checked).toEqual([
            { requested: "seurat", present: true, name: "Seurat", section: "R (CRAN)" },
            { requested: "DESEQ2", present: true, name: "DESeq2", section: "R (Bioconductor)" },
        ]);
    });
});

describe("queryPackages — listing", () => {
    it("bounds a no-arg call and reports truthful total/hasMore", () => {
        const result = queryPackages(SECTIONS, { limit: 4 });
        if (!result.available || !("total" in result)) throw new Error("expected a listing result");

        expect(result.total).toBe(12);
        expect(result.returned).toBe(4);
        expect(result.hasMore).toBe(true);
        expect(result.content).toContain("Seurat, dplyr, ggplot2");
        // Truncation is stated, not silent.
        expect(result.content).toContain("more");
    });

    it("returns everything with hasMore=false when the limit is not reached", () => {
        const result = queryPackages(SECTIONS, {});
        if (!result.available || !("total" in result)) throw new Error("expected a listing result");

        expect(result.total).toBe(12);
        expect(result.returned).toBe(12);
        expect(result.hasMore).toBe(false);
    });

    it("filters by language track", () => {
        const result = queryPackages(SECTIONS, { language: "r" });
        if (!result.available || !("total" in result)) throw new Error("expected a listing result");

        // The R triple only: CRAN + Bioconductor (+ GitHub when present).
        expect(result.total).toBe(6);
        expect(result.content).toContain("R (CRAN)");
        expect(result.content).toContain("R (Bioconductor)");
        expect(result.content).not.toContain("Python (pip)");
    });

    it("filters by case-insensitive substring query", () => {
        const result = queryPackages(SECTIONS, { query: "seq" });
        if (!result.available || !("total" in result)) throw new Error("expected a listing result");

        // DESeq2 + pydeseq2.
        expect(result.total).toBe(2);
        expect(result.content).toContain("DESeq2");
        expect(result.content).toContain("pydeseq2");
    });

    it("reports an empty match honestly rather than dumping the catalog", () => {
        const result = queryPackages(SECTIONS, { query: "nosuchpackage" });
        if (!result.available || !("total" in result)) throw new Error("expected a listing result");

        expect(result.total).toBe(0);
        expect(result.hasMore).toBe(false);
        expect(result.content).toContain("No packages match");
    });
});

describe("queryRefs", () => {
    it("bounds a no-arg call and reports truthful total/hasMore plus the category index", () => {
        const result = queryRefs(REGISTRY, { limit: 2 });
        if (!result.available) throw new Error("expected an available result");

        expect(result.total).toBe(6);
        expect(result.returned).toBe(2);
        expect(result.hasMore).toBe(true);
        // The category index always ships, so a bounded first call still tells the
        // agent what exists and what to drill into.
        expect(result.categories).toEqual(["atlas_singlecell", "msigdb", "gene_mappings"]);
        expect(result.content).toContain("not shown (limit reached)");
    });

    it("returns everything with hasMore=false when the limit is not reached", () => {
        const result = queryRefs(REGISTRY, {});
        if (!result.available) throw new Error("expected an available result");

        expect(result.total).toBe(6);
        expect(result.returned).toBe(6);
        expect(result.hasMore).toBe(false);
        expect(result.content).toContain("/mnt/refs/msigdb/h.all.gmt");
    });

    it("filters to one category", () => {
        const result = queryRefs(REGISTRY, { category: "msigdb" });
        if (!result.available) throw new Error("expected an available result");

        expect(result.total).toBe(3);
        expect(result.hasMore).toBe(false);
        expect(result.content).toContain("MSigDB Gene Set Collections");
        expect(result.content).not.toContain("pan_t.h5ad");
    });

    it("names the valid categories when given an unknown one", () => {
        const result = queryRefs(REGISTRY, { category: "nope" });
        if (!result.available) throw new Error("expected an available result");

        expect(result.total).toBe(0);
        expect(result.content).toContain('Unknown category "nope"');
        expect(result.content).toContain("atlas_singlecell");
    });

    it("filters by substring over the registry's descriptive fields", () => {
        // `dataset` is a real registry field — match on it, not on an invented one.
        const byDataset = queryRefs(REGISTRY, { query: "zheng" });
        if (!byDataset.available) throw new Error("expected an available result");
        expect(byDataset.total).toBe(1);
        expect(byDataset.content).toContain("pan_t.h5ad");

        const byPath = queryRefs(REGISTRY, { query: "orthologs" });
        if (!byPath.available) throw new Error("expected an available result");
        expect(byPath.total).toBe(1);
        expect(byPath.content).toContain("orthologs_9606.parquet");
    });

    it("reports an empty match honestly rather than dumping the registry", () => {
        const result = queryRefs(REGISTRY, { query: "nosuchref" });
        if (!result.available) throw new Error("expected an available result");

        expect(result.total).toBe(0);
        expect(result.content).toContain("No reference files match");
    });
});
