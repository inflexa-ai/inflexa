import { stripHtmlAndCollapseWs } from "../../../../tools/lib/pathway-client.js";

export type PathwayRow = {
    id: string;
    name: string;
    source: "reactome" | "kegg";
    url: string;
    entity_uniprots?: string[];
    metadata?: { species_present?: string[] };
};

const REACTOME_ID_RE = /^R-([A-Z]+)-(\d+)/;

export function stripHtml(s: string): string {
    return stripHtmlAndCollapseWs(s);
}

export function dedupPathwaysAcrossSpecies(rows: PathwayRow[], opts: { geneSymbolEchoFilter?: string; assessmentUniprot?: string } = {}): PathwayRow[] {
    // Group Reactome rows by stable suffix; KEGG/other sources pass through.
    const reactomeGroups = new Map<string, PathwayRow[]>();
    const others: PathwayRow[] = [];

    for (const r of rows) {
        if (r.source !== "reactome") {
            others.push(r);
            continue;
        }
        const m = REACTOME_ID_RE.exec(r.id);
        if (!m) {
            others.push(r);
            continue;
        }
        const suffix = m[2]!;
        const arr = reactomeGroups.get(suffix) ?? [];
        arr.push(r);
        reactomeGroups.set(suffix, arr);
    }

    const collapsed: PathwayRow[] = [];
    for (const group of reactomeGroups.values()) {
        const withSpecies = group.map((r) => ({
            r,
            species: REACTOME_ID_RE.exec(r.id)![1]!,
        }));
        const human = withSpecies.find((x) => x.species === "HSA");
        const winner = (human ?? withSpecies[0]!).r;
        const species_present = withSpecies.map((x) => x.species);
        collapsed.push({
            ...winner,
            metadata: { ...(winner.metadata ?? {}), species_present },
        });
    }

    const merged = [...collapsed, ...others];

    let filtered = merged;
    if (opts.assessmentUniprot) {
        filtered = filtered.filter((r) => {
            if (r.source !== "reactome") return true; // only Reactome carries entity_uniprots
            if (!r.entity_uniprots || r.entity_uniprots.length === 0) return true; // graceful fallback when fetch failed
            return r.entity_uniprots.includes(opts.assessmentUniprot!);
        });
    }
    if (opts.geneSymbolEchoFilter) {
        const echo = opts.geneSymbolEchoFilter.toLowerCase();
        filtered = filtered.filter((r) => r.name.toLowerCase() !== echo);
    }
    return filtered;
}

// `stripHtmlAndCollapseWs` is the underlying helper — kept in scope so the
// `stripHtml` re-export above stays callable.
void stripHtmlAndCollapseWs;
