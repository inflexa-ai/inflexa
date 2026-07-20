# DADA2 API Reference

R/Bioconductor package for amplicon sequence variant (ASV) inference from 16S and ITS amplicon sequencing data. Resolves exact biological sequences at single-nucleotide resolution without OTU clustering.

## Setup

```r
library(dada2)
```

## Full Pipeline Overview

```
filterAndTrim → learnErrors → dada → mergePairs → makeSequenceTable → removeBimeraDenovo → assignTaxonomy
```

Each function operates on files or objects produced by the previous step. The pipeline runs separately on forward and reverse reads through `learnErrors` and `dada`, then merges at `mergePairs`.

## filterAndTrim() — Quality Filtering and Trimming

Filters and trims paired-end or single-end FASTQ files. Writes filtered files to an output directory.

```r
out <- filterAndTrim(
  fwd,                       # character vector — paths to input forward FASTQ files
  filt,                      # character vector — paths to output filtered forward FASTQ files
  rev = NULL,                # character vector | NULL — paths to input reverse FASTQ files
  filt.rev = NULL,           # character vector | NULL — paths to output filtered reverse FASTQ files
  truncLen = 0,              # integer (or length-2 vector) — truncate reads at this length (0 = no truncation)
  trimLeft = 0,              # integer (or length-2 vector) — trim this many bases from 5' end
  trimRight = 0,             # integer (or length-2 vector) — trim this many bases from 3' end
  maxN = 0,                  # integer — max ambiguous bases (N) allowed (DADA2 requires 0)
  maxEE = c(2, 2),           # numeric (or length-2 vector) — max expected errors per read
  truncQ = 2,                # integer — truncate reads at first base with quality <= this
  minLen = 20,               # integer — discard reads shorter than this after trimming
  rm.phix = TRUE,            # logical — remove PhiX spike-in reads
  compress = TRUE,           # logical — gzip output files
  multithread = TRUE,        # logical | integer — use multiple threads (TRUE = all cores)
  verbose = TRUE
)
# Returns: matrix with columns "reads.in" and "reads.out", one row per sample
```

### Choosing truncLen

```r
# Inspect quality profiles to choose truncLen
plotQualityProfile(fnFs[1:4])  # forward reads
plotQualityProfile(fnRs[1:4])  # reverse reads

# Truncate where median quality drops below ~30
# For 2x250 V4 data, typical values: truncLen = c(240, 160)
# For 2x300 V3-V4 data, typical values: truncLen = c(280, 200)
# Forward reads are usually higher quality — truncate reverse more aggressively
```

### 16S vs ITS Trimming

```r
# 16S: use truncLen to cut at fixed length (amplicon length is consistent)
out <- filterAndTrim(fnFs, filtFs, fnRs, filtRs,
                     truncLen = c(240, 160),
                     maxEE = c(2, 2), truncQ = 2,
                     rm.phix = TRUE, compress = TRUE, multithread = TRUE)

# ITS: do NOT use truncLen (ITS amplicon length is variable)
# Use only maxEE filtering and enforce minLen
out <- filterAndTrim(fnFs, filtFs, fnRs, filtRs,
                     truncLen = 0,
                     maxEE = c(2, 2), truncQ = 2,
                     minLen = 50,
                     rm.phix = TRUE, compress = TRUE, multithread = TRUE)
```

## learnErrors() — Error Rate Learning

Learns the error rates from the data using an alternating expectation-maximization algorithm. Run separately for forward and reverse reads.

```r
errF <- learnErrors(
  filtFs,                    # character vector — paths to filtered FASTQ files (or derep objects)
  nbases = 1e8,             # numeric — minimum total bases to use for learning (default 1e8)
  multithread = TRUE,        # logical | integer — use multiple threads
  randomize = FALSE,         # logical — randomize sample order (useful if samples are sorted by quality)
  MAX_CONSIST = 10,          # integer — max EM iterations
  verbose = TRUE
)

errR <- learnErrors(filtRs, multithread = TRUE)
```

### Inspecting Error Rates

```r
# ALWAYS plot error rates to verify the model
p <- plotErrors(errF, nominalQ = TRUE)
ggsave("figures/error_rates_forward.png", p, width = 10, height = 8, dpi = 300)

p <- plotErrors(errR, nominalQ = TRUE)
ggsave("figures/error_rates_reverse.png", p, width = 10, height = 8, dpi = 300)

# Good error model: black line (estimated) tracks black dots (observed)
# and decreases monotonically with quality score.
# Bad signs: flat or non-monotonic estimated error rates, large deviations
# from observed rates.
```

## dada() — Sample Inference (Core ASV Algorithm)

Infers true biological sequences by modeling and correcting amplicon errors. This is the core denoising step.

```r
dadaFs <- dada(
  filtFs,                    # character vector — paths to filtered FASTQ files (or derep objects)
  err = errF,                # error model from learnErrors()
  multithread = TRUE,        # logical | integer — use multiple threads
  pool = FALSE,              # FALSE | TRUE | "pseudo" — pooling strategy (see below)
  verbose = TRUE
)

dadaRs <- dada(filtRs, err = errR, multithread = TRUE)
```

### pool Parameter

```r
# pool = FALSE (default): samples processed independently. Fastest. May miss rare
# sequences present at low abundance across many samples.
dadaFs <- dada(filtFs, err = errF, pool = FALSE, multithread = TRUE)

# pool = TRUE: all samples pooled for inference. Detects rare cross-sample variants
# but memory-intensive (loads all samples into RAM).
dadaFs <- dada(filtFs, err = errF, pool = TRUE, multithread = TRUE)

# pool = "pseudo": two-pass approach. First pass independent, second pass uses
# cross-sample priors. Compromise between sensitivity and memory.
dadaFs <- dada(filtFs, err = errF, pool = "pseudo", multithread = TRUE)
```

### Inspecting dada Results

```r
# Summary for first sample
dadaFs[[1]]
# Returns: number of true sequence variants inferred from N input unique sequences

# Number of ASVs per sample
sapply(dadaFs, function(x) length(x$denoised))
```

## mergePairs() — Merge Paired-End Reads

Merges denoised forward and reverse reads. Requires sufficient overlap between the forward and reverse reads in the amplicon region.

```r
merged <- mergePairs(
  dadaFs,                    # list of dada-class objects (forward)
  filtFs,                    # character vector — paths to filtered forward FASTQ files
  dadaRs,                    # list of dada-class objects (reverse)
  filtRs,                    # character vector — paths to filtered reverse FASTQ files
  minOverlap = 12,           # integer — minimum overlap in base pairs to merge
  maxMismatch = 0,           # integer — max mismatches allowed in overlap region
  verbose = TRUE
)
# Returns: list of data.frames, one per sample, with columns:
#   sequence, abundance, forward, reverse, nmatch, nmismatch, nindel, prefer, accept
```

### Checking Merge Success

```r
# Inspect merge rates per sample
sapply(merged, function(x) sum(x$accept) / nrow(x))

# If merge rate is very low (<50%):
# 1. Reads may not overlap — check that truncLen leaves enough overlap
#    Overlap = fwd_len + rev_len - amplicon_len (should be >= 20 bp)
# 2. Try increasing maxMismatch to 1
# 3. For non-overlapping reads, consider concatenation (not standard DADA2)
```

## makeSequenceTable() — Construct ASV Table

Constructs a sample-by-ASV count matrix from the merged (or denoised) sequences.

```r
seqtab <- makeSequenceTable(merged)
# Returns: integer matrix — rows = samples, columns = ASV sequences
# Column names are the actual DNA sequences

dim(seqtab)
# [1] n_samples n_ASVs

# Inspect sequence length distribution
table(nchar(getSequences(seqtab)))
# 16S V4: expect ~252-254 bp
# 16S V3-V4: expect ~420-430 bp
# ITS: variable length (200-600+ bp)
```

### Filtering by Sequence Length

```r
# Remove sequences outside expected amplicon length range
# For 16S V4 region:
seqtab <- seqtab[, nchar(colnames(seqtab)) %in% 250:256]

# For ITS (keep broad range since length varies):
seqtab <- seqtab[, nchar(colnames(seqtab)) %in% 100:600]
```

## removeBimeraDenovo() — Chimera Removal

Identifies and removes bimeric (chimeric) sequences. Chimeras are artifacts formed during PCR when incomplete extension products act as primers in subsequent cycles.

```r
seqtab.nochim <- removeBimeraDenovo(
  seqtab,                    # integer matrix — from makeSequenceTable()
  method = "consensus",      # "consensus" | "pooled" | "per-sample"
  multithread = TRUE,        # logical | integer — use multiple threads
  verbose = TRUE
)
# Returns: integer matrix with chimeric sequences removed

# Check chimera removal rate
cat("Chimeras removed:", ncol(seqtab) - ncol(seqtab.nochim), "of", ncol(seqtab), "ASVs\n")
cat("Reads retained:", sum(seqtab.nochim) / sum(seqtab) * 100, "%\n")
# Typical: 1-10% of ASVs are chimeric, but they represent a small fraction of reads
# If >25% of reads are removed, investigate upstream steps (trimming, error rates)
```

## assignTaxonomy() — Taxonomic Classification

Assigns taxonomy using the RDP Naive Bayesian Classifier algorithm against a reference database.

```r
taxa <- assignTaxonomy(
  seqtab.nochim,             # integer matrix | character vector of sequences
  refFasta,                  # character — path to reference FASTA (SILVA, UNITE, etc.)
  minBoot = 50,              # integer — minimum bootstrap confidence for assignment (default 50)
  tryRC = FALSE,             # logical — also try reverse complement
  multithread = TRUE,        # logical | integer — use multiple threads
  verbose = TRUE
)
# Returns: character matrix — rows = sequences, columns = Kingdom through Species
#          (or through Genus for SILVA, with addSpecies for species-level)
```

### Reference Databases

`assignTaxonomy()` and `addSpecies()` take a *path* to a reference FASTA. A bare filename is not one — it resolves against the working directory, where reference data does not live, and the call fails there rather than at the end of a long pipeline.

**Resolve the training set before you write the script.** Ask for the *database* by what it is, not by a path — reference data is provisioned per-environment, so the directory, the filename, and the release version all vary and none of them are yours to assume:

| You need | Ask for | Standard sources |
|-|-|-|
| 16S genus-level taxonomy | A DADA2-formatted taxonomy training FASTA for 16S | SILVA (v138.1 is the common release) |
| 16S species-level assignment | A DADA2-formatted species-assignment FASTA for 16S | SILVA species assignment |
| ITS fungal taxonomy | A DADA2-formatted taxonomy training FASTA for ITS | UNITE general release, all eukaryotes |

The data contract matters more than the name. `assignTaxonomy()` needs the **DADA2-formatted training** version of a database: a gzipped FASTA whose headers are semicolon-delimited taxonomy strings from Kingdom down (`Bacteria;Firmicutes;Bacilli;…`), not accession-style headers. `addSpecies()` needs the **species-assignment** version, a different file whose headers are `ID Genus species`. The two are not interchangeable, and passing a plain sequence database to either produces an immediate parse failure or, worse, an all-`NA` taxonomy table. Match the marker region too — SILVA against ITS reads, or UNITE against 16S reads, runs to completion and returns nonsense.

**SILVA and UNITE training sets are not currently in the reference inventory.** If you look and they are not there, report that taxonomy assignment cannot be run and hand back the ASV table, sequences, and read tracking, which are complete and useful without it. Do not invent a path, do not substitute a general-purpose sequence database, and do not drop the taxonomy step silently.

```r
# 16S: `silva_train_path` and `silva_species_path` are paths you resolved,
# not literals to copy.
taxa <- assignTaxonomy(seqtab.nochim, silva_train_path, multithread = TRUE)
taxa <- addSpecies(taxa, silva_species_path)

# ITS (fungal): `unite_train_path` is a path you resolved.
taxa <- assignTaxonomy(seqtab.nochim, unite_train_path,
                       multithread = TRUE, tryRC = TRUE)
```

### Bootstrap Confidence

```r
# Retrieve bootstrap values (not returned by default).
# `silva_train_path` is a path you resolved — see Reference Databases above.
taxa_with_boot <- assignTaxonomy(seqtab.nochim, silva_train_path,
                                  multithread = TRUE, outputBootstraps = TRUE)
# taxa_with_boot$tax — taxonomy assignments
# taxa_with_boot$boot — bootstrap confidence values (0-100)

# Filter low-confidence assignments
taxa_clean <- taxa_with_boot$tax
boot <- taxa_with_boot$boot
taxa_clean[boot < 70] <- NA  # mask assignments below 70% confidence
```

## addSpecies() — Species-Level Assignment by Exact Matching

Assigns species by exact matching against a reference database. Only works when sequences have unambiguous exact matches.

```r
taxa <- addSpecies(
  taxa,                      # character matrix — from assignTaxonomy()
  refFasta,                  # character — path to species-level reference FASTA
  allowMultiple = FALSE,     # logical — allow multiple species matches per ASV
  tryRC = FALSE,             # logical — also try reverse complement
  verbose = TRUE
)
# Adds a "Species" column to the taxonomy matrix
# NA for sequences without an exact match
```

## Track Reads Through Pipeline

Standard practice: track reads at each step to diagnose losses.

```r
getN <- function(x) sum(getUniques(x))

track <- cbind(
  out,                                   # filterAndTrim output (reads.in, reads.out)
  sapply(dadaFs, getN),                  # denoised forward
  sapply(dadaRs, getN),                  # denoised reverse
  sapply(merged, getN),                  # merged
  rowSums(seqtab.nochim)                 # non-chimeric
)
colnames(track) <- c("input", "filtered", "denoisedF", "denoisedR", "merged", "nonchim")
rownames(track) <- sample_names

write.csv(track, "output/read_tracking.csv")
```

## Full Pipeline Example: 16S Paired-End

```r
library(dada2)

# --- File Discovery ---
path <- "data/fastq"
fnFs <- sort(list.files(path, pattern = "_R1_001.fastq.gz", full.names = TRUE))
fnRs <- sort(list.files(path, pattern = "_R2_001.fastq.gz", full.names = TRUE))
sample_names <- gsub("_R1_001.fastq.gz", "", basename(fnFs))

# --- Quality Profiles ---
p <- plotQualityProfile(fnFs[1:4])
ggsave("figures/quality_forward.png", p, width = 10, height = 8, dpi = 300)
p <- plotQualityProfile(fnRs[1:4])
ggsave("figures/quality_reverse.png", p, width = 10, height = 8, dpi = 300)

# --- Filter and Trim ---
filtFs <- file.path("output", "filtered", paste0(sample_names, "_F_filt.fastq.gz"))
filtRs <- file.path("output", "filtered", paste0(sample_names, "_R_filt.fastq.gz"))
names(filtFs) <- sample_names
names(filtRs) <- sample_names

out <- filterAndTrim(fnFs, filtFs, fnRs, filtRs,
                     truncLen = c(240, 160),
                     maxEE = c(2, 2), truncQ = 2,
                     rm.phix = TRUE, compress = TRUE, multithread = TRUE)

# Remove samples that had zero reads pass filter
keep <- out[, "reads.out"] > 0
filtFs <- filtFs[keep]
filtRs <- filtRs[keep]

# --- Learn Error Rates ---
errF <- learnErrors(filtFs, multithread = TRUE)
errR <- learnErrors(filtRs, multithread = TRUE)

p <- plotErrors(errF, nominalQ = TRUE)
ggsave("figures/error_rates_forward.png", p, width = 10, height = 8, dpi = 300)
p <- plotErrors(errR, nominalQ = TRUE)
ggsave("figures/error_rates_reverse.png", p, width = 10, height = 8, dpi = 300)

# --- Denoise ---
dadaFs <- dada(filtFs, err = errF, multithread = TRUE)
dadaRs <- dada(filtRs, err = errR, multithread = TRUE)

# --- Merge Paired Reads ---
merged <- mergePairs(dadaFs, filtFs, dadaRs, filtRs, verbose = TRUE)

# --- Construct ASV Table ---
seqtab <- makeSequenceTable(merged)
cat("ASV table dimensions:", dim(seqtab), "\n")
table(nchar(getSequences(seqtab)))

# --- Remove Chimeras ---
seqtab.nochim <- removeBimeraDenovo(seqtab, method = "consensus", multithread = TRUE, verbose = TRUE)
cat("Reads retained after chimera removal:", sum(seqtab.nochim) / sum(seqtab) * 100, "%\n")

# --- Assign Taxonomy ---
# SILVA paths resolved per Reference Databases; if unavailable, report it and
# stop here — the ASV table below is still complete.
taxa <- assignTaxonomy(seqtab.nochim, silva_train_path, multithread = TRUE)
taxa <- addSpecies(taxa, silva_species_path)

# --- Track Reads ---
getN <- function(x) sum(getUniques(x))
track <- cbind(out[keep, ], sapply(dadaFs, getN), sapply(dadaRs, getN),
               sapply(merged, getN), rowSums(seqtab.nochim))
colnames(track) <- c("input", "filtered", "denoisedF", "denoisedR", "merged", "nonchim")
rownames(track) <- sample_names[keep]
write.csv(track, "output/read_tracking.csv")

# --- Export for phyloseq ---
library(phyloseq)
ps <- phyloseq(
  otu_table(seqtab.nochim, taxa_are_rows = FALSE),
  tax_table(taxa)
)
# Add sample metadata
meta_df <- read.csv("data/metadata.csv", row.names = 1)
sample_data(ps) <- sample_data(meta_df)

# Add short ASV names for convenience
dna <- Biostrings::DNAStringSet(taxa_names(ps))
names(dna) <- taxa_names(ps)
ps <- merge_phyloseq(ps, dna)
taxa_names(ps) <- paste0("ASV", seq(ntaxa(ps)))

saveRDS(ps, "output/phyloseq_object.rds")
```

## Full Pipeline Example: ITS Paired-End

```r
library(dada2)

# --- File Discovery ---
path <- "data/fastq"
fnFs <- sort(list.files(path, pattern = "_R1_001.fastq.gz", full.names = TRUE))
fnRs <- sort(list.files(path, pattern = "_R2_001.fastq.gz", full.names = TRUE))
sample_names <- gsub("_R1_001.fastq.gz", "", basename(fnFs))

# --- Filter and Trim (NO truncLen for ITS) ---
filtFs <- file.path("output", "filtered", paste0(sample_names, "_F_filt.fastq.gz"))
filtRs <- file.path("output", "filtered", paste0(sample_names, "_R_filt.fastq.gz"))
names(filtFs) <- sample_names
names(filtRs) <- sample_names

out <- filterAndTrim(fnFs, filtFs, fnRs, filtRs,
                     truncLen = 0,
                     maxEE = c(2, 2), truncQ = 2,
                     minLen = 50,
                     rm.phix = TRUE, compress = TRUE, multithread = TRUE)

keep <- out[, "reads.out"] > 0
filtFs <- filtFs[keep]
filtRs <- filtRs[keep]

# --- Learn Error Rates ---
errF <- learnErrors(filtFs, multithread = TRUE)
errR <- learnErrors(filtRs, multithread = TRUE)

# --- Denoise ---
dadaFs <- dada(filtFs, err = errF, multithread = TRUE)
dadaRs <- dada(filtRs, err = errR, multithread = TRUE)

# --- Merge ---
merged <- mergePairs(dadaFs, filtFs, dadaRs, filtRs, verbose = TRUE)

# --- ASV Table ---
seqtab <- makeSequenceTable(merged)

# ITS: broader length filtering (variable amplicon length)
seqtab <- seqtab[, nchar(colnames(seqtab)) %in% 100:600]

# --- Remove Chimeras ---
seqtab.nochim <- removeBimeraDenovo(seqtab, method = "consensus", multithread = TRUE, verbose = TRUE)

# --- Assign Taxonomy (UNITE) ---
# `unite_train_path` resolved per Reference Databases; if unavailable, report it
# and stop here — the ASV table is still complete.
taxa <- assignTaxonomy(seqtab.nochim, unite_train_path,
                       multithread = TRUE, tryRC = TRUE)

# --- Track Reads ---
getN <- function(x) sum(getUniques(x))
track <- cbind(out[keep, ], sapply(dadaFs, getN), sapply(dadaRs, getN),
               sapply(merged, getN), rowSums(seqtab.nochim))
colnames(track) <- c("input", "filtered", "denoisedF", "denoisedR", "merged", "nonchim")
rownames(track) <- sample_names[keep]

# --- Export ---
write.csv(track, "output/read_tracking.csv")
saveRDS(seqtab.nochim, "output/seqtab_nochim.rds")
saveRDS(taxa, "output/taxonomy.rds")
```

## Single-End Reads

For single-end data, skip `mergePairs` and pass the dada result directly to `makeSequenceTable`.

```r
# Filter (no rev/filt.rev)
out <- filterAndTrim(fnFs, filtFs,
                     truncLen = 240, maxEE = 2, truncQ = 2,
                     rm.phix = TRUE, compress = TRUE, multithread = TRUE)

# Learn errors and denoise
errF <- learnErrors(filtFs, multithread = TRUE)
dadaFs <- dada(filtFs, err = errF, multithread = TRUE)

# ASV table directly from denoised reads (no merge step)
seqtab <- makeSequenceTable(dadaFs)

# Continue with removeBimeraDenovo and assignTaxonomy as usual
```

## Primer Removal (Pre-DADA2)

DADA2 does not remove primers. If primers are still in the reads (common for ITS), remove them before `filterAndTrim`.

```r
# Using cutadapt (external tool, must be installed)
# Forward primer: CTTGGTCATTTAGAGGAAGTAA (ITS1f)
# Reverse primer: GCTGCGTTCTTCATCGATGC (ITS2)

# From R, call cutadapt via system()
FWD <- "CTTGGTCATTTAGAGGAAGTAA"
REV <- "GCTGCGTTCTTCATCGATGC"
REV_RC <- dada2::rc(REV)
FWD_RC <- dada2::rc(FWD)

for (i in seq_along(fnFs)) {
  system2("cutadapt", args = c(
    "-g", FWD, "-a", REV_RC,
    "-G", REV, "-A", FWD_RC,
    "--discard-untrimmed",
    "-o", nopFs[i], "-p", nopRs[i],
    fnFs[i], fnRs[i]
  ))
}
# Then run filterAndTrim on nopFs/nopRs (primer-removed files)
```

## Exporting Results

```r
# ASV count matrix (samples x ASVs)
asv_mat <- as.data.frame(seqtab.nochim)
asv_mat$sample_id <- rownames(asv_mat)
write.csv(asv_mat, "output/asv_counts.csv", row.names = FALSE)

# Taxonomy table
tax_df <- as.data.frame(taxa)
tax_df$sequence <- rownames(tax_df)
write.csv(tax_df, "output/taxonomy.csv", row.names = FALSE)

# FASTA of ASV sequences
uniquesToFasta(seqtab.nochim, "output/asv_sequences.fasta")

# For phyloseq handoff (most common downstream path)
saveRDS(seqtab.nochim, "output/seqtab_nochim.rds")
saveRDS(taxa, "output/taxonomy.rds")
```

## Gotchas

- **ITS must not use truncLen.** ITS amplicons have variable length. Truncating to a fixed length cuts real biological sequence. Use `truncLen = 0` and rely on `maxEE` and `minLen` filtering only.
- **Always inspect error rate plots.** Call `plotErrors()` after `learnErrors()` and check that estimated rates (black line) track observed rates (black dots) and decrease monotonically with quality. A bad error model silently produces unreliable ASVs.
- **maxN must be 0.** DADA2 does not accept ambiguous bases. If input reads contain N bases, `filterAndTrim` with `maxN = 0` (the default) removes them.
- **Primers must be removed before DADA2.** DADA2 does not handle primer removal. If primers are in the reads (especially ITS data), use cutadapt first. Residual primers cause spurious ASVs.
- **Merge requires sufficient overlap.** If `mergePairs` drops too many reads, the `truncLen` values are too aggressive. Calculate: `fwd_truncLen + rev_truncLen - amplicon_length >= 20` for adequate overlap.
- **Column names of seqtab are DNA sequences.** The ASV table uses full DNA sequences as column names, not short IDs. Rename to ASV1, ASV2, etc. after the pipeline is complete, preserving the sequence-to-ID mapping.
- **Reference databases must match the marker.** Use SILVA for 16S, UNITE for ITS. Using the wrong database produces nonsensical taxonomy rather than an error. The reference FASTA must also be the DADA2-formatted training version — semicolon-delimited taxonomy headers, not accession headers — and `addSpecies()` needs the separate species-assignment file, not the training set.
- **Reference FASTAs are paths, never bare filenames.** `assignTaxonomy(seqtab, "something.fa.gz")` resolves against the working directory and fails there; pass a path resolved from the reference data available to you. There is no network egress, so fetching a training set at runtime is not an option — and SILVA and UNITE training sets are not currently in the reference inventory. When they are absent, report it and deliver the ASV table without taxonomy; never invent a path or quietly skip the step.
- **Chimera removal removes ASVs, not reads.** `removeBimeraDenovo` removes chimeric sequences but the read count typically drops only 1-10%. If >25% of reads are lost, upstream steps (trimming, error learning) need investigation.
- **Pool for rare taxa.** `pool = FALSE` (default) processes samples independently and may miss rare sequences. Use `pool = "pseudo"` when detecting low-abundance cross-sample variants matters. Full `pool = TRUE` is memory-intensive for large datasets.
- **Track reads through every step.** Always build the tracking table (input -> filtered -> denoised -> merged -> nonchim). A sharp drop at any step indicates a problem: large loss at filterAndTrim means poor quality or wrong truncLen; large loss at mergePairs means insufficient overlap; large loss at removeBimeraDenovo means upstream contamination or poor error models.
- **File naming must be consistent.** `filterAndTrim` matches forward and reverse files by position in the input vectors. Ensure `fnFs` and `fnRs` are sorted identically (use `sort()` on both). Mismatched pairs produce silent errors.
- **Memory for large datasets.** `learnErrors` and `dada` with `pool = TRUE` load all reads into memory. For >100 samples, use `pool = "pseudo"` or `pool = FALSE`. Reduce `nbases` in `learnErrors` if memory is limited (1e8 is usually sufficient).
- **assignTaxonomy minBoot default is 50.** For publication, report the bootstrap threshold used. Many studies use 70 or 80. Lower values assign more taxa but with less confidence.
