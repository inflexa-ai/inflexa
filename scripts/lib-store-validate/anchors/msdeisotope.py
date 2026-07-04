#!/usr/bin/env python3
"""Anchor: ms_deisotope (proteomics) — run the Cython-compiled deisotoping /
peak-picking backend over a synthetic isotopic envelope. A clean import can pass
while the compiled extension is broken; this does real numeric work."""
import numpy as np
from ms_deisotope import deconvolute_peaks
from ms_deisotope.averagine import peptide
from ms_deisotope.scoring import PenalizedMSDeconVFitter

# A synthetic +2 isotopic envelope around m/z 500 (spacing 0.5 Th).
base_mz = 500.0
mzs = np.array([base_mz + i * 0.5 for i in range(5)], dtype=float)
intensities = np.array([100.0, 60.0, 25.0, 8.0, 2.0], dtype=float)
peaks = list(zip(mzs, intensities))

result = deconvolute_peaks(
    peaks,
    averagine=peptide,
    scorer=PenalizedMSDeconVFitter(5.0, 2.0),
    charge_range=(1, 3),
)

envelopes = list(result.peak_set)
assert envelopes, "deconvolution produced no envelopes"
print(f"ms_deisotope anchor OK: {len(envelopes)} deconvoluted envelope(s)")
