#!/usr/bin/env python3
"""The warm workload of matplotlib.

The font cache arrives with the first import of pyplot, and the render proves
the Agg path that each analysis writes its figures through. The bytes go to a
buffer in memory, because the workload writes no file.
"""

import io

import matplotlib

# A container has no display, thus an analysis renders through Agg. Name the
# backend before the first import of pyplot.
matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import seaborn as sns  # noqa: E402


def main() -> None:
    rng = np.random.default_rng(0)
    frame = pd.DataFrame(rng.normal(size=(20, 10)), columns=[f"g{i}" for i in range(10)])
    # `sns.heatmap` is the seaborn entry point of this product: the skill
    # references draw their matrices with it.
    fig, ax = plt.subplots(figsize=(4, 3))
    sns.heatmap(frame, cmap="RdBu_r", center=0, ax=ax)
    ax.set_title("marker expression")
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", dpi=100, bbox_inches="tight")
    plt.close(fig)
    print(f"[warm] matplotlib: figure of {len(buffer.getvalue())} bytes")


if __name__ == "__main__":
    main()
