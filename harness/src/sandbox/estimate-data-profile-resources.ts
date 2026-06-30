import type { ResourceSpec } from "../config/resource-limits.js";

const EXPANSION: Record<string, number> = {
    csv: 8,
    tsv: 8,
    txt: 8,
    json: 8,
    jsonl: 8,
    ndjson: 8,
    xlsx: 15,
    xls: 15,
    gz: 12,
    bz2: 12,
    zip: 12,
    xz: 12,
    zst: 12,
    parquet: 4,
    feather: 4,
    arrow: 4,
    orc: 4,
    h5: 4,
    hdf5: 4,
    nc: 4,
    mat: 4,
    npy: 4,
    npz: 4,
    bam: 2,
    cram: 2,
    sam: 2,
    vcf: 2,
    bcf: 2,
    bed: 2,
    gff: 2,
    gtf: 2,
    fastq: 2,
    fasta: 2,
    fa: 2,
    fq: 2,
    rds: 6,
    rdata: 6,
    rda: 6,
    pdf: 1,
    png: 1,
    jpg: 1,
    jpeg: 1,
    svg: 1,
    html: 1,
    md: 1,
};

// Unknown / extensionless files default to 6× in-memory expansion.
const DEFAULT_FACTOR = 6;

function factorFor(relativePath: string): number {
    const base = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    if (dot <= 0) return DEFAULT_FACTOR;
    return EXPANSION[base.slice(dot + 1).toLowerCase()] ?? DEFAULT_FACTOR;
}

export function estimateDataProfileResources(files: ReadonlyArray<{ relativePath: string; size: number }>): ResourceSpec {
    if (files.length === 0) return { cpu: 1, memoryGb: 2 };

    let largest = files[0];
    let totalBytes = 0;
    for (const f of files) {
        totalBytes += f.size;
        if (f.size > largest.size) largest = f;
    }

    const memoryGb = Math.max(2, Math.ceil(2 + (largest.size * factorFor(largest.relativePath)) / 1e9));

    let cpu = totalBytes < 100 * 1e6 ? 1 : totalBytes < 1e9 ? 2 : totalBytes < 10 * 1e9 ? 4 : 8;
    if (files.length >= 8) cpu += 1;
    cpu = Math.max(1, cpu);

    return { cpu, memoryGb };
}
