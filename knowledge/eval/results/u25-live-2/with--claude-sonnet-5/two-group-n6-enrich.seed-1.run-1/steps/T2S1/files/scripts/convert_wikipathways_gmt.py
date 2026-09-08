"""Convert the staged WikiPathways human GMT to HGNC-symbol gene sets.

The staged file (/mnt/refs/managed/wikipathways-human/2026.07.10/) documents
its members as "HGNC symbols" in the reference inventory, but the file itself
carries NCBI Entrez Gene IDs (all-numeric tokens) as members, with a
'%'-delimited descriptor (name%source%WPid%species) as the first field and a
pathway URL as the second field. This script:

  1. Parses the '%'-delimited descriptor to recover a readable pathway name
     and its stable WikiPathways ID (kept in the name to avoid collisions).
  2. Maps each Entrez Gene ID to its current HGNC-approved symbol using the
     NCBI human gene_info table (GeneID -> Symbol), so the gene sets carry
     the same identifier space as the DESeq2 results table (HGNC symbols).
  3. Writes a standard GMT (name, description/URL, member symbols) that
     fgsea::gmtPathways() reads directly.

Unmapped Entrez IDs (no current record in gene_info, e.g. withdrawn/replaced
IDs) are dropped from their set and counted; sets are otherwise unfiltered
here -- size filtering (min/max) happens in the fgsea step itself.
"""
import gzip
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

WIKIPATHWAYS_GMT = Path("/mnt/refs/managed/wikipathways-human/2026.07.10/wikipathways_Homo_sapiens.gmt")
NCBI_GENE_INFO = Path("/mnt/refs/managed/ncbi-gene-human/current/Homo_sapiens.gene_info.gz")
OUTPUT_GMT = Path("output/wikipathways_human_2026.07.10_hgnc_symbols.gmt")
OUTPUT_LOG = Path("logs/convert_wikipathways_gmt.log")


def load_entrez_to_symbol(path: Path) -> dict[str, str]:
    """Load Entrez GeneID -> approved HGNC Symbol from the NCBI gene_info table."""
    mapping: dict[str, str] = {}
    with gzip.open(path, "rt") as fh:
        header = fh.readline().lstrip("#").rstrip("\n").split("\t")
        gene_id_idx = header.index("GeneID")
        symbol_idx = header.index("Symbol")
        for line in fh:
            fields = line.rstrip("\n").split("\t")
            mapping[fields[gene_id_idx]] = fields[symbol_idx]
    logger.info("Loaded %d Entrez GeneID -> Symbol mappings from %s", len(mapping), path)
    return mapping


def parse_descriptor(descriptor: str) -> tuple[str, str]:
    """Split the '%'-delimited first field into (readable_name, wikipathways_id)."""
    parts = descriptor.split("%")
    name = parts[0]
    wp_id = parts[2] if len(parts) > 2 else "NA"
    return name, wp_id


def convert_gmt(gmt_path: Path, entrez_to_symbol: dict[str, str]) -> tuple[list[str], dict]:
    """Convert one WikiPathways GMT line per pathway to symbol-based GMT lines."""
    out_lines = []
    n_pathways = 0
    n_genes_total = 0
    n_genes_mapped = 0
    n_pathways_empty_after_map = 0
    with open(gmt_path) as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line:
                continue
            fields = line.split("\t")
            descriptor, url, *entrez_ids = fields
            name, wp_id = parse_descriptor(descriptor)
            set_name = f"{name} ({wp_id})".replace(" ", "_").replace(",", "")
            symbols = []
            for eid in entrez_ids:
                n_genes_total += 1
                sym = entrez_to_symbol.get(eid)
                if sym is not None:
                    symbols.append(sym)
                    n_genes_mapped += 1
            symbols = sorted(set(symbols))
            n_pathways += 1
            if not symbols:
                n_pathways_empty_after_map += 1
                continue
            out_lines.append("\t".join([set_name, url, *symbols]))
    stats = {
        "n_pathways_input": n_pathways,
        "n_pathways_output": len(out_lines),
        "n_pathways_empty_after_map": n_pathways_empty_after_map,
        "n_genes_total_tokens": n_genes_total,
        "n_genes_mapped": n_genes_mapped,
        "mapping_rate": round(n_genes_mapped / n_genes_total, 4) if n_genes_total else None,
    }
    return out_lines, stats


def main() -> None:
    Path("output").mkdir(parents=True, exist_ok=True)
    Path("logs").mkdir(parents=True, exist_ok=True)
    entrez_to_symbol = load_entrez_to_symbol(NCBI_GENE_INFO)
    out_lines, stats = convert_gmt(WIKIPATHWAYS_GMT, entrez_to_symbol)
    OUTPUT_GMT.write_text("\n".join(out_lines) + "\n")
    logger.info("Wrote %d pathways to %s", len(out_lines), OUTPUT_GMT)
    logger.info("Stats: %s", stats)
    with open(OUTPUT_LOG, "w") as fh:
        fh.write(f"source_gmt: {WIKIPATHWAYS_GMT}\n")
        fh.write(f"entrez_to_symbol_source: {NCBI_GENE_INFO}\n")
        fh.write(f"output_gmt: {OUTPUT_GMT}\n")
        fh.writelines(f"{k}: {v}\n" for k, v in stats.items())


if __name__ == "__main__":
    main()
