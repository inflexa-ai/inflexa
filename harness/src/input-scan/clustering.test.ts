import { describe, expect, it } from "bun:test";

import type { ContentSimilarity, DirectoryEntry } from "./clustering.js";
import { buildTree, clusterChildren, computeSignatures } from "./clustering.js";
import type { MemberFile } from "./set-types.js";
import { basenameOf } from "./tokens.js";

function member(path: string): MemberFile {
    return { path, name: basenameOf(path), size: 1024, format: "unknown", companions: [] };
}

/** The children of `parent`, as the descent hands them to the clusterer. */
function childrenOf(paths: readonly string[], parent: string): DirectoryEntry[] {
    let node = computeSignatures(buildTree(paths.map(member)));
    for (const segment of parent.split("/")) node = node.children.get(segment)!;
    return [...node.children.values()].map((child) => ({ node: child, varValues: [] }));
}

function perSpecimenTree(count: number): string[] {
    const paths: string[] = [];
    for (let i = 1; i <= count; i++) {
        const specimen = `specimen-${String(i).padStart(2, "0")}`;
        paths.push(`inputs/${specimen}/reads.fastq.gz`, `inputs/${specimen}/metrics.tsv`, `inputs/${specimen}/summary.json`);
    }
    return paths;
}

describe("clusterChildren", () => {
    it("gathers sibling directories that agree into one template", () => {
        const clusters = clusterChildren(childrenOf(perSpecimenTree(8), "inputs"));

        expect(clusters).toHaveLength(1);
        expect(clusters[0]!.names).toHaveLength(8);
        expect(clusters[0]!.entries).toHaveLength(8);
    });

    it("leaves a sibling holding unrelated content outside the cluster", () => {
        const paths = [...perSpecimenTree(8), "inputs/paperwork/protocol.pdf", "inputs/paperwork/consent.docx"];

        const clusters = clusterChildren(childrenOf(paths, "inputs")).sort((a, b) => b.names.length - a.names.length);

        expect(clusters).toHaveLength(2);
        expect(clusters[0]!.names).toHaveLength(8);
        expect(clusters[1]!.names).toEqual(["paperwork"]);
    });

    it("keeps directories apart when neither their names nor their contents agree", () => {
        const paths = [
            "inputs/imaging/scan_01.tiff",
            "inputs/imaging/scan_02.tiff",
            "inputs/tabular/measures.csv",
            "inputs/tabular/subjects.csv",
            "inputs/writing/report.md",
        ];

        const clusters = clusterChildren(childrenOf(paths, "inputs"));

        expect(clusters).toHaveLength(3);
    });

    it("merges on injected content agreement where structure alone says nothing", () => {
        const paths = ["inputs/first/alpha.csv", "inputs/first/beta.csv", "inputs/second/gamma.tsv", "inputs/second/delta.tsv"];
        const structural = clusterChildren(childrenOf(paths, "inputs"));
        expect(structural).toHaveLength(2);

        const identicalSchemas: ContentSimilarity = () => 1;
        const withContent = clusterChildren(childrenOf(paths, "inputs"), identicalSchemas);

        expect(withContent).toHaveLength(1);
        expect(withContent[0]!.names.sort()).toEqual(["first", "second"]);
    });

    it("ignores a hook that has no opinion", () => {
        const paths = ["inputs/first/alpha.csv", "inputs/second/gamma.tsv"];
        const noOpinion: ContentSimilarity = () => undefined;

        expect(clusterChildren(childrenOf(paths, "inputs"), noOpinion)).toHaveLength(2);
    });
});

describe("computeSignatures", () => {
    it("carries a child's masked templates up into its parent's signature", () => {
        const root = computeSignatures(buildTree(perSpecimenTree(2).map(member)));
        const inputs = root.children.get("inputs")!;

        expect(inputs.childNames).toEqual(new Set(["specimen-01", "specimen-02"]));
        expect([...inputs.fineSignature]).toContain("specimen-#/metrics tsv");
    });
});
