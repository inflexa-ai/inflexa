#!/usr/bin/env bash
# Anchor: samtools — round-trip a tiny SAM through the compiled binary
# (view -> sort -> index -> stats), not just `--version`.
set -euo pipefail

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
sam="$work/in.sam"

cat > "$sam" <<'SAM'
@HD	VN:1.6	SO:unsorted
@SQ	SN:chr1	LN:1000
r1	0	chr1	100	60	10M	*	0	0	ACGTACGTAC	IIIIIIIIII
r2	0	chr1	50	60	10M	*	0	0	TTTTAAAACC	IIIIIIIIII
r3	16	chr1	200	60	10M	*	0	0	GGGGCCCCAA	IIIIIIIIII
SAM

samtools view -b "$sam" > "$work/in.bam"
samtools sort -o "$work/sorted.bam" "$work/in.bam"
samtools index "$work/sorted.bam"
mapped="$(samtools view -c "$work/sorted.bam")"

test "$mapped" -eq 3
echo "samtools anchor OK: sorted + indexed $mapped reads"
