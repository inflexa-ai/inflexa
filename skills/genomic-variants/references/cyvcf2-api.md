# cyvcf2 API Reference

Fast VCF/BCF parser built on htslib via Cython. Returns numpy arrays for genotype fields, making it efficient for population-scale analyses.

## Opening and Iterating

```python
from cyvcf2 import VCF

# Open VCF/BCF (auto-detects format from extension)
vcf = VCF("variants.vcf.gz")

# Iterate all variants
for v in vcf:
    print(v.CHROM, v.start, v.end)  # start is 0-based, end is 1-based
    print(v.POS)                     # 1-based position (same as VCF POS column)
    print(v.ID)                      # variant ID or None
    print(v.REF)                     # reference allele string
    print(v.ALT)                     # list of alt alleles e.g. ['C', 'T']
    print(v.QUAL)                    # quality score (float or None)
    print(v.FILTER)                  # None if PASS, otherwise filter string

vcf.close()
```

## Region Queries

```python
vcf = VCF("variants.vcf.gz")

# Query a specific region (requires tabix index)
for v in vcf("chr1:100000-200000"):
    print(v.CHROM, v.POS, v.REF, v.ALT)
```

## INFO Field Access

```python
for v in vcf:
    # Access INFO fields by name
    dp = v.INFO.get("DP")      # int or None if absent
    af = v.INFO.get("AF")      # float (first value for Number=A)
    fs = v.INFO.get("FS")      # float

    # Flag fields return True/False
    is_db = v.INFO.get("DB")   # True if flag present, None otherwise

    # Convert entire variant back to VCF line
    vcf_line = str(v)
```

## Genotype Access (numpy arrays)

```python
for v in vcf:
    # gt_types: per-sample genotype classification (numpy int array)
    # 0=HOM_REF, 1=HET, 2=UNKNOWN, 3=HOM_ALT
    gt_types = v.gt_types

    # Allelic depths
    ref_depths = v.gt_ref_depths    # numpy array of ref allele depths
    alt_depths = v.gt_alt_depths    # numpy array of alt allele depths

    # Phase and quality
    phases = v.gt_phases            # numpy bool array (True=phased)
    quals = v.gt_quals              # numpy float array of GQ values

    # Human-readable genotypes e.g. ['A/T', 'T/T']
    bases = v.gt_bases              # numpy string array

    # Raw genotype list: [[allele1, allele2, is_phased], ...]
    # e.g. [[0, 1, False], [1, 1, True]]
    genotypes = v.genotypes
```

## FORMAT Field Access

```python
for v in vcf:
    # format() returns a numpy array of shape (n_samples, n_values)
    dp = v.format("DP")            # shape (n_samples, 1) int array
    ad = v.format("AD")            # shape (n_samples, n_alleles) int array
    pl = v.format("PL")            # shape (n_samples, n_genotypes) int array

    # Example: get per-sample allele depths
    if ad is not None:
        for i, sample_ad in enumerate(ad):
            ref_count, alt_count = sample_ad[0], sample_ad[1]
```

## Sample Information

```python
vcf = VCF("variants.vcf.gz")

# List sample names
print(vcf.samples)                # list of sample name strings

# Restrict to specific samples (must call before iteration)
vcf = VCF("variants.vcf.gz", samples=["NA12878", "NA12891"])

# Or exclude samples with a dash prefix
vcf = VCF("variants.vcf.gz", samples=["^NA12878"])
```

## Filtering Patterns

```python
from cyvcf2 import VCF
import numpy as np

vcf = VCF("variants.vcf.gz")

results = []
for v in vcf:
    # Skip non-PASS variants
    if v.FILTER is not None:
        continue
    # Keep only biallelic SNPs
    if not v.is_snp or len(v.ALT) != 1:
        continue
    # Minimum quality
    if v.QUAL is not None and v.QUAL < 30:
        continue
    # Minimum allele frequency
    af = v.INFO.get("AF")
    if af is not None and af < 0.01:
        continue
    # Collect per-sample het count
    n_het = np.sum(v.gt_types == 1)
    results.append((v.CHROM, v.POS, v.REF, v.ALT[0], af, n_het))
```

## Writing VCF Output

```python
from cyvcf2 import VCF, Writer

vcf = VCF("input.vcf.gz")

# Add custom INFO field to header
vcf.add_info_to_header({
    "ID": "MyAnnotation",
    "Description": "Custom annotation value",
    "Type": "Float",
    "Number": "1",
})

# Create writer from input VCF template
w = Writer("output.vcf.gz", vcf)

for v in vcf:
    # Add/modify INFO field
    v.INFO["MyAnnotation"] = 0.95
    w.write_record(v)

w.close()
vcf.close()
```

## Modifying Genotypes

```python
from cyvcf2 import VCF, Writer
import numpy as np

vcf = VCF("input.vcf.gz")
vcf.add_format_to_header({
    "ID": "FT", "Description": "Sample filter",
    "Type": "String", "Number": "1",
})

w = Writer("output.vcf", vcf)

for v in vcf:
    # Set low-depth samples to no-call
    dp = v.format("DP")
    if dp is not None:
        for i in range(len(vcf.samples)):
            if dp[i][0] < 10:
                v.genotypes[i] = [-1, -1, False]
        # Must reassign to trigger internal update
        v.genotypes = v.genotypes
    w.write_record(v)

w.close()
vcf.close()
```

## Gotchas

- **Array reuse**: cyvcf2 reuses internal numpy arrays between variants for performance. If you need to persist values across iterations, copy them: `cpy = np.array(v.gt_types)`.
- **FILTER semantics**: `v.FILTER` is `None` when the variant passes all filters (PASS). A non-None value is the filter string.
- **0-based vs 1-based**: `v.start` is 0-based, `v.POS` is 1-based. `v.end` is 1-based.
- **INFO type coercion**: `v.INFO.get()` returns Python int/float/str. For Number=A or Number=R fields with multiple values, it returns only the first value; use `v.INFO` dict-style access for the full tuple.
- **format() returns None** if the FORMAT field is not present in the variant record.
- **genotypes reassignment**: After modifying `v.genotypes` entries in-place, you must reassign `v.genotypes = v.genotypes` to trigger internal reprocessing before writing.
- **is_snp / is_indel / is_sv**: Convenience booleans for variant type classification.
