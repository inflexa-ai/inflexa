# pysam API Reference

Python interface to SAM/BAM/CRAM and VCF/BCF files via htslib. Provides `AlignmentFile` for read alignments and `VariantFile` for variant records.

## Opening BAM/CRAM Files

```python
import pysam

# BAM file (binary, requires index .bai)
bam = pysam.AlignmentFile("sample.bam", "rb")

# CRAM file (requires reference FASTA)
cram = pysam.AlignmentFile("sample.cram", "rc", reference_filename="ref.fa")

# SAM file (text, no index needed)
sam = pysam.AlignmentFile("sample.sam", "r")
```

## Iterating Over Reads

```python
bam = pysam.AlignmentFile("sample.bam", "rb")

# Fetch reads in a region (requires index)
for read in bam.fetch("chr1", 100000, 200000):
    print(read.query_name)           # read name
    print(read.reference_start)      # 0-based start position
    print(read.reference_end)        # 0-based exclusive end
    print(read.query_sequence)       # read sequence
    print(read.query_qualities)      # base qualities (array)
    print(read.cigarstring)          # CIGAR string e.g. "76M"
    print(read.mapping_quality)      # MAPQ
    print(read.is_reverse)           # strand
    print(read.is_secondary)         # secondary alignment
    print(read.is_supplementary)     # supplementary alignment
    print(read.is_duplicate)         # PCR duplicate flag
    print(read.is_proper_pair)       # properly paired

# Count reads in a region
count = bam.count("chr1", 100000, 200000)

# Index statistics per contig
for stat in bam.get_index_statistics():
    print(f"{stat.contig}: {stat.mapped} mapped, {stat.unmapped} unmapped")

bam.close()
```

## Read Tags and Aligned Pairs

```python
for read in bam.fetch("chr1", 100000, 200000):
    # Auxiliary tags (e.g. NM = edit distance, MD = mismatch string)
    if read.has_tag("NM"):
        nm = read.get_tag("NM")

    # Aligned pairs: list of (query_pos, ref_pos) tuples
    # query_pos is None for deletions, ref_pos is None for insertions
    pairs = read.get_aligned_pairs()

    # With reference sequence (requires MD tag)
    pairs_with_seq = read.get_aligned_pairs(with_seq=True)
    # Each tuple: (query_pos, ref_pos, ref_base)

    # Contiguous aligned blocks: list of (ref_start, ref_end) tuples
    blocks = read.get_blocks()

    # CIGAR stats: [counts_per_op, counts_per_op_bases]
    cigar_stats = read.get_cigar_stats()
```

## Pileup (Per-Position Coverage)

```python
bam = pysam.AlignmentFile("sample.bam", "rb")

for col in bam.pileup("chr1", 100000, 100100):
    print(f"pos={col.pos} coverage={col.n}")
    for pileupread in col.pileups:
        if not pileupread.is_del and not pileupread.is_refskip:
            base = pileupread.alignment.query_sequence[pileupread.query_position]
            qual = pileupread.alignment.query_qualities[pileupread.query_position]

# Fast per-base coverage counts (returns 4 arrays: A, C, G, T)
a, c, g, t = bam.count_coverage("chr1", 100000, 100100, quality_threshold=15)
total_at_first = a[0] + c[0] + g[0] + t[0]

bam.close()
```

## VCF/BCF Reading

```python
vcf = pysam.VariantFile("variants.vcf.gz")

# Header access
print(list(vcf.header.contigs))    # chromosome names
print(list(vcf.header.samples))    # sample names
print(list(vcf.header.info))       # INFO field IDs
print(list(vcf.header.formats))    # FORMAT field IDs

# Iterate all variants
for rec in vcf.fetch():
    print(rec.contig, rec.pos, rec.id)    # pos is 1-based
    print(rec.ref, rec.alts)               # REF string, ALT tuple
    print(rec.qual)                        # QUAL float
    print(list(rec.filter.keys()))         # FILTER keys

    # INFO fields
    dp = rec.info.get("DP")               # returns None if absent
    af = rec.info.get("AF")               # tuple for Number=A fields

    # Per-sample genotype data
    for sample in rec.samples:
        gt = rec.samples[sample]["GT"]     # tuple e.g. (0, 1)
        dp = rec.samples[sample].get("DP") # None if absent

# Region query (requires tabix index .tbi or .csi)
for rec in vcf.fetch("chr1", 100000, 200000):
    pass

vcf.close()
```

## VCF Filtering and Writing

```python
vcf_in = pysam.VariantFile("input.vcf.gz")
vcf_out = pysam.VariantFile("filtered.vcf.gz", "w", header=vcf_in.header)

for rec in vcf_in.fetch():
    # Keep only high-quality SNPs
    if rec.qual and rec.qual >= 30:
        if len(rec.ref) == 1 and all(len(a) == 1 for a in rec.alts):
            vcf_out.write(rec)

vcf_out.close()
vcf_in.close()
```

## Creating a VCF from Scratch

```python
header = pysam.VariantHeader()
header.add_line("##fileformat=VCFv4.2")
header.info.add("DP", 1, "Integer", "Total Depth")
header.info.add("AF", "A", "Float", "Allele Frequency")
header.formats.add("GT", 1, "String", "Genotype")
header.formats.add("DP", 1, "Integer", "Read Depth")
header.add_sample("Sample1")
header.contigs.add("chr1", length=248956422)

with pysam.VariantFile("output.vcf", "w", header=header) as vcf:
    rec = vcf.new_record(
        contig="chr1", start=100, stop=101,
        alleles=("A", "T"), qual=50, filter="PASS",
        info={"DP": 30, "AF": [0.5]},
        samples=[{"GT": (0, 1), "DP": 15}],
    )
    vcf.write(rec)
```

## Gotchas

- **Coordinates**: BAM positions are 0-based half-open. VCF `rec.pos` is 1-based, but `rec.start` is 0-based.
- **Index required**: `fetch()` and region queries need an index (`.bai` for BAM, `.tbi`/`.csi` for VCF). Use `pysam.index()` or `pysam.tabix_index()` to create one.
- **File modes**: `"rb"` = BAM, `"rc"` = CRAM, `"r"` = SAM. For VCF the mode is auto-detected; `"w"` writes uncompressed VCF, `"wz"` writes bgzipped VCF, `"wb"` writes BCF.
- **pileup() extends beyond region**: By default `pileup()` returns columns for reads overlapping the region, which may extend beyond the requested coordinates. Use `truncate=True` to clip.
- **query_sequence is None** for unmapped reads or reads with no sequence stored.
- **count_coverage** is much faster than manual pileup iteration for simple base counting.
