# Count provenance report

**Verdict:** Counts are integer-valued and per-sample sums are library-scale (not ~1,000,000), consistent with raw, non-length-scaled read counts -- FPKM/TPM values are essentially never integer, and TPM sums to exactly 1e6 per sample by construction; neither signature is present here. The mean-count-vs-length Spearman correlation is essentially null (rho = -0.013, p = 0.15). This argues AGAINST the values already being length-scaled: if counts.csv held FPKM/TPM-like quantities (raw_count / length), dividing by length imposes a mechanical negative correlation with length unless the underlying raw counts were engineered to compensate almost exactly -- a coincidence, not a default. A null correlation is also compatible with raw counts drawn without a modeled length-capture bias (plausible for a simulated dataset). Net effect: this diagnostic does not by itself prove the counts are raw, but it rules out the clearest length-division signature.

## Checks performed
- Integer-valued (no fractional counts): TRUE
- Negative values present: 0
- Value range: [0, 26238]
- Per-sample library sizes (colSums): min = 420347, median = 1614280, max = 2694991
- Per-sample sums ~= 1,000,000 (TPM signature): FALSE
- Gene set in counts.csv exactly matches gene_lengths.csv (12000 genes both files): TRUE
- Spearman correlation, mean count vs. gene length: rho = -0.013, p = 1.46e-01 (see figures/count_vs_gene_length_provenance.png)

## Conclusion
gene_length_reference.csv is treated as NOT applied to counts.csv: counts.csv is modeled as raw integer
read counts, and gene_length_reference.csv is not consumed further in the DESeq2 model (DESeq2's own
median-of-ratios size factors handle library-size normalization; gene length is a within-sample, not a
between-sample or between-condition, artifact and does not enter a two-group comparison of the same genes).
The length-vs-log2FoldChange diagnostic in the primary DE script provides an additional post-hoc check
for residual length-associated bias in the DE result itself.
