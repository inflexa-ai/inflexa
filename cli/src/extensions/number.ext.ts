declare global {
    interface Number {
        /**
         * Formats a byte count as one compact human string — `812 B`, `1.0 KB`, `36.0 MB`, `1.4 GB`.
         * Whole bytes below 1024, then one decimal of the largest fitting unit, each unit stepping at
         * 1024 of the one below it. The labels are the short `KB`/`MB`/`GB` the rest of the CLI already
         * prints (the embedding setup step, the harness's report preflight) rather than the strictly
         * correct IEC `KiB`/`MiB`/`GiB`: one wizard printing `1.4 GiB` two steps below another printing
         * `36.0 MB` reads as two different products. The 1024 basis is the trade-off that buys that
         * consistency, and is stated here because the labels no longer state it themselves.
         *
         * An instance method so a byte count reads as one at the call site (`written.formatBytes()`),
         * and the single place any byte quantity is rendered — a second formatter is how a tree ends up
         * with three vocabularies. Negative and non-finite inputs clamp to `0 B` rather than printing
         * `-1.0 KB` or `NaN B`, the way {@link Date.relativeAge} clamps a future timestamp: an
         * unusable input is unknowable, not renderable.
         */
        formatBytes(): string;
    }
}

Number.prototype.formatBytes = function (this: number): string {
    if (!Number.isFinite(this)) return "0 B";
    const bytes = Math.max(0, this);
    // Decide the whole-bytes branch on the ROUNDED value, not the raw one: rounding only after the
    // `< 1024` check lets 1023.6 print a nonsensical "1024 B". Rounding first keeps the threshold and
    // the rendered number in agreement, so 1023.6 crosses into the next unit and reads "1.0 KB".
    const wholeBytes = Math.round(bytes);
    if (wholeBytes < 1024) return `${wholeBytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    // GB is deliberately the top unit: a terabyte-scale readout would be a reference store gone wrong,
    // and "1536.0 GB" stays honest where a TB step would quietly make it look ordinary.
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
};

export {};
