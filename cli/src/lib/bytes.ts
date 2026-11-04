/**
 * Render a byte count with IEC labels, in the largest unit that keeps it readable: whole bytes and
 * `B` below 1024, then one decimal and `KiB`, `MiB`, `GiB`, or `TiB`. A count above the top unit stays
 * in `TiB`. It is not `Number.prototype.formatBytes`, which labels with `KB` and rounds differently.
 */
export function formatIecBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    let value = bytes / 1024;
    for (const unit of ["KiB", "MiB", "GiB"]) {
        if (value < 1024) return `${value.toFixed(1)} ${unit}`;
        value /= 1024;
    }
    return `${value.toFixed(1)} TiB`;
}
