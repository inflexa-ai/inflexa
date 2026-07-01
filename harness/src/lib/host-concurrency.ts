/**
 * Per-source HTTP concurrency cap helper.
 *
 * Several Phase-3 fan-outs hit the same upstream (chembl, openfda,
 * clinicaltrials.gov) from multiple branches. Without a host-level cap, a
 * single shortlist of 8 modulators × 4 fan-out sub-workflows could open
 * 32 concurrent requests against ChEMBL — well past polite usage. This
 * module exposes a tiny semaphore keyed by host so all branches share
 * one budget per upstream.
 *
 * Usage:
 *   import { withHost } from "../../lib/host-concurrency.js";
 *   const result = await withHost("chembl", () => chembl.getMechanism(id));
 */

const DEFAULT_LIMITS: Record<string, number> = {
    chembl: 4,
    openfda: 4,
    ctgov: 4,
    opentargets: 4,
    ensembl: 6,
    ncbi: 3,
    bgee: 4,
    cbioportal: 3,
    string: 3,
    reactome: 4,
    kegg: 4,
    hgnc: 6,
    uniprot: 6,
    iuphar: 4,
    ema: 2,
    pubchem: 4,
    "annotation-llm": 4,
    default: 4,
};

interface HostBudget {
    limit: number;
    inUse: number;
    queue: Array<() => void>;
}

const budgets = new Map<string, HostBudget>();

function getBudget(host: string): HostBudget {
    let b = budgets.get(host);
    if (!b) {
        b = { limit: DEFAULT_LIMITS[host] ?? DEFAULT_LIMITS.default, inUse: 0, queue: [] };
        budgets.set(host, b);
    }
    return b;
}

/** Acquire a slot, run `body`, release on completion (success or failure). */
export async function withHost<T>(host: string, body: () => Promise<T>): Promise<T> {
    const b = getBudget(host);
    if (b.inUse >= b.limit) {
        await new Promise<void>((resolve) => b.queue.push(resolve));
    }
    b.inUse += 1;
    try {
        return await body();
    } finally {
        b.inUse -= 1;
        const next = b.queue.shift();
        if (next) next();
    }
}
