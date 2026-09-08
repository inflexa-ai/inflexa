"""Clean the WikiPathways human GMT for fgsea.

The staged file
`/mnt/refs/managed/wikipathways-human/2026.07.10/wikipathways_Homo_sapiens.gmt`
packs the pathway name, WikiPathways ID, and species into one '%'-delimited
first field (e.g. "Glutathione metabolism%WikiPathways_20260710%WP100%Homo
sapiens"), and its gene members are Entrez Gene IDs, not HGNC symbols as the
reference-store catalog entry states (verified by direct inspection: every
member token is numeric). This script rewrites the first field to a readable
"NAME (WPID)" pathway name and leaves the Entrez gene ID members untouched, so
fgsea::gmtPathways() reads a normal GMT and the results table carries readable
pathway names.
"""

import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

SRC = "/mnt/refs/managed/wikipathways-human/2026.07.10/wikipathways_Homo_sapiens.gmt"
DST = "output/refdata/wikipathways_clean.gmt"


def clean_line(line: str) -> str:
    fields = line.rstrip("\n").split("\t")
    descriptor = fields[0]
    parts = descriptor.split("%")
    name = parts[0]
    wpid = parts[2] if len(parts) > 2 else "WP?"
    clean_name = f"{name} ({wpid})"
    rest = fields[1:]
    return "\t".join([clean_name, *rest])


def main() -> None:
    import os

    os.makedirs("output/refdata", exist_ok=True)
    n_lines = 0
    with open(SRC, encoding="utf-8") as fin, open(DST, "w", encoding="utf-8") as fout:
        for line in fin:
            if not line.strip():
                continue
            fout.write(clean_line(line) + "\n")
            n_lines += 1
    logger.info("Wrote %d WikiPathways gene sets to %s", n_lines, DST)


if __name__ == "__main__":
    main()
