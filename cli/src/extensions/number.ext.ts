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
    // Every tier picks its unit from the value it would actually PRINT, not the raw one. Comparing the
    // raw value against the next step instead lets a number that rounds up at the top of a range stay
    // in that range and render a unit that does not exist: 1023.6 as "1024 B", or 1048575 — a byte
    // short of a megabyte — as "1024.0 KB".
    const wholeBytes = Math.round(bytes);
    if (wholeBytes < 1024) return `${wholeBytes} B`;
    let scaled = bytes / 1024;
    for (const unit of ["KB", "MB"] as const) {
        if (Number(scaled.toFixed(1)) < 1024) return `${scaled.toFixed(1)} ${unit}`;
        scaled /= 1024;
    }
    // GB is deliberately the top unit: a terabyte-scale readout would be a reference store gone wrong,
    // and "1536.0 GB" stays honest where a TB step would quietly make it look ordinary.
    return `${scaled.toFixed(1)} GB`;
};

export {};
