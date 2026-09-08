# Gene Identifier Annotation & Mapping-Coverage Report

## Bottom line

**36.53% of gene identifiers (4,384 / 12,000) map to a real HGNC symbol, Entrez ID, and Ensembl gene ID via `org.Hs.eg.db` 3.23.1. 63.47% (7,616 / 12,000) are unmapped.** These figures are read directly from `output/annotation_summary.json` (`n_mapped: 4384`, `mapped_share: 0.3653`, `n_unmapped: 7616`, `unmapped_share: 0.6347`, `n_rows`/`n_input: 12000`). The unmapped count matches the data profile's independently stated ~7,616 synthetic-placeholder genes almost exactly, and `output/annotation_unmapped.csv` confirms the unmapped rows are the `GENE00001`, `GENE00002`, `GENE00003`, `GENE00004` … placeholder series, not real symbols that failed to resolve.

## Method

- **Input:** `data/inputs/local/counts.csv`, the 12,000-gene × 12-sample raw count matrix, `gene` column — recorded in `annotation_summary.json` (`"input"`, `"gene_column": "gene"`). No DESeq2 results table existed from any completed upstream step at execution time, so the count matrix (which carries the identical gene-ID vocabulary) was used; `annotation_mapping.csv` is built to be joined onto that or any downstream table by `input_id`.
- **Organism package:** `org.Hs.eg.db` version **3.23.1**, Entrez Gene source date **2026-Mar18**, Ensembl source date **2025-Sep03** (`annotation_summary.json`: `organism_package_version`, `entrez_source_date`, `ensembl_source_date`). Organism = human, per `organism: "human"` in the same file — an explicit assumption, not a value read from the data (see Caveats).
- **Identifier-space detection:** `annotation_summary.json`'s `pattern_share` shows `ensembl: 0`, `entrez: 0`, `symbol: 1` — every one of the 12,000 unique input IDs matched the symbol pattern by elimination, none matched an Ensembl-gene or plain-integer pattern. `input_space` / `input_space_setting` were both set to `"symbol"`.
- **Mapping calls:** `AnnotationDbi::mapIds()`, `SYMBOL → ENTREZID` and `SYMBOL → ENSEMBL`, each run with `multiVals = "list"` so one-to-many hits are counted before collapsing.
- **Alias fallback:** enabled (`alias_fallback: true`); rescued **`n_alias_mapped: 4`** identifiers out of the non-current-symbol candidates via `ALIAS → ENTREZID` lookup — a negligible addition to the mapped total.
- **Ensembl version stripping:** enabled (`strip_ensembl_version: true`); had no effect here since no Ensembl-pattern IDs were present in the input.
- **One-to-many rule:** `"first"` (`multi_map_rule: "first"`) — kept the package's first-returned target when an ID mapped to more than one target; every case is logged rather than silently dropped.
- **Duplicates:** `n_duplicate_rows: 0` — all 12,000 gene rows in the matrix are unique identifiers.
- **Identifier-space separation:** `output/annotation_mapping.csv` holds `input_id`, `symbol`, `entrez_id`, `ensembl_id`, `mapped` as distinct columns — the original ID is preserved untouched and never overwritten by a mapped value.

## Quantitative results (all from `output/annotation_summary.json` unless noted)

| Metric | Value |
|---|---|
| Total gene IDs (rows) | 12,000 |
| Unique input identifiers | 12,000 |
| Duplicate rows | 0 |
| Mapped | 4,384 (36.53%) |
| Unmapped | 7,616 (63.47%) |
| One-to-many cases (unique input IDs, any target space) | 274 |
| — of which one-to-many on Entrez | 3 (`n_multi_by_space.entrez_id`) |
| — of which one-to-many on Ensembl | 272 (`n_multi_by_space.ensembl_id`) |
| Alias-fallback rescues | 4 |
| Multi-map rule applied | "first" |

`output/annotation_mapping.csv` (opened directly) confirms the mapped rows carry real values in all three target columns, e.g.:
- `ABCA1 → symbol=ABCA1, entrez_id=19, ensembl_id=ENSG00000165029, mapped=TRUE`
- `ACADM → symbol=ACADM, entrez_id=34, ensembl_id=ENSG00000117054, mapped=TRUE`

`output/annotation_multi.csv` (opened directly) shows example one-to-many cases and the "first" resolution, e.g.:
- `CIR1, entrez_id, n_targets=2, targets="7335;9541", kept=7335`
- `ADIPOR2, ensembl_id, n_targets=2, targets="ENSG00000006831;ENSG00000285070", kept=ENSG00000006831`

`output/annotation_unmapped.csv` (opened directly) shows the unmapped rows begin `GENE00001`, `GENE00002`, `GENE00003`, `GENE00004`, consistent with the synthetic placeholder block.

## Environment / provenance (from `output/decision_record.json` and `output/session_info.txt`)

- Template: `tpl-annotation-map@1.0.0`, method `M-0057`, snapshot digest `sha256:40605ae40583456c222ca9f595c1a4c8c995b7a124a1f35c57cb03911412e5e8`.
- Package pins (exact match): `AnnotationDbi 1.74.0`, `org.Hs.eg.db 3.23.1`, `ggplot2 4.0.3`, `jsonlite 2.0.0`, on `R version 4.6.0 (2026-04-24)`, platform `aarch64-unknown-linux-gnu`, Ubuntu 24.04.4 LTS (`session_info.txt`).
- Citations recorded in the decision record: Durinck et al. 2009 (biomaRt identifier mapping, doi:10.1038/nprot.2009.97) and Wu et al. 2021 (clusterProfiler 4.0, doi:10.1016/j.xinn.2021.100141), both marked `direction: supports`.

## Figures produced

- `figures/annotation_mapping_status.png/.pdf` — stacked bars of one-to-one / one-to-many / unmapped outcome per target identifier space.
- `figures/annotation_input_patterns.png/.pdf` — bars of the identifier-pattern shares (`ensembl`, `entrez`, `symbol`) that drove input-space detection, matching the `pattern_share` values in `annotation_summary.json`.

## Quality notes

- **Sample size:** the mapping was run over the full 12,000-gene matrix with 0 duplicate rows and 0 missing/empty gene-ID cells — full coverage, no filtering was applied prior to mapping.
- **Consistency check:** the empirically measured unmapped share (63.47%, `annotation_summary.json`) lines up almost exactly with the data profile's independently stated ~63% (~7,616) synthetic-placeholder fraction, and the identity of the unmapped rows (`GENE#####` series, `annotation_unmapped.csv`) confirms the two figures describe the same underlying phenomenon rather than being a coincidence of two different failure modes.
- **Alias fallback added minimal value:** only 4 identifiers were rescued this way, so its enabled/disabled state does not materially move the headline mapped share.

## Limitations

1. **Organism assumption is unverified.** `organism: "human"` in `annotation_summary.json` is a stated default, not a value derived from any species/organism field in the inputs — none exists in the source data. If the true organism differs, both the mapped count and the identities behind it would be wrong, and this cannot be checked from the data at hand.
2. **The unmapped 63.47% is unmapped by construction, not by mapping-tool limitation.** These are synthetic placeholder IDs with no real biological identity in any organism database; no choice of organism package, alias strategy, or identifier-space setting would recover annotation for them.
3. **One-to-many collapsing discards alternatives.** The "first" rule (`multi_map_rule: "first"`) reduces 274 one-to-many identifiers to a single kept target each in the primary mapping table; the discarded alternatives are preserved only in `annotation_multi.csv`, not in the main mapping table used downstream.
4. **Restricted downstream universe.** Only the mapped 4,384 genes (36.53% of the matrix) carry real Entrez/HGNC/Ensembl identity and can feed a real annotation-based enrichment analysis; any enrichment step built on this mapping table is implicitly scoped to that minority of genes, and that scope must be reported as a limitation of the enrichment results, not absorbed silently.